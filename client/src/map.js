/**
 * GEOINT Dashboard — OpenLayers Map Module
 *
 * Sets up the primary map view with:
 * - Dark-themed OSM base layer
 * - WebGL-optimized vector layer for asset positions
 * - Polygon layer for geofence zones with classification-based styling
 * - Breach highlight overlay (pulsing red ring on breached assets)
 * - Asset popup overlay
 * - Coordinate tracking and zoom display
 */

import Map from 'ol/Map.js';
import View from 'ol/View.js';
import TileLayer from 'ol/layer/Tile.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import OSM from 'ol/source/OSM.js';
import { fromLonLat, toLonLat } from 'ol/proj.js';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import Overlay from 'ol/Overlay.js';
import { Style, Fill, Stroke, Circle as CircleStyle, Text as TextStyle, Icon, RegularShape } from 'ol/style.js';
import { defaults as defaultControls } from 'ol/control.js';
import GeoJSON from 'ol/format/GeoJSON.js';

// ── Asset Style Mapping ─────────────────────────────────────

const ASSET_COLORS = {
  MARITIME: '#06b6d4',
  AERIAL: '#8b5cf6',
  GROUND: '#f97316',
  SUBSURFACE: '#14b8a6',
  DEFAULT: '#3b82f6',
};

const ZONE_STYLES = {
  RESTRICTED: { fill: 'rgba(239, 68, 68, 0.12)', stroke: '#ef4444', dash: [] },
  EXCLUSION: { fill: 'rgba(220, 38, 38, 0.18)', stroke: '#dc2626', dash: [] },
  WARNING: { fill: 'rgba(245, 158, 11, 0.10)', stroke: '#f59e0b', dash: [10, 5] },
  MONITORING: { fill: 'rgba(59, 130, 246, 0.08)', stroke: '#3b82f6', dash: [5, 10] },
};

// ── Style Factories ─────────────────────────────────────────

function createAssetStyle(feature) {
  const type = feature.get('assetType') || 'DEFAULT';
  const color = ASSET_COLORS[type] || ASSET_COLORS.DEFAULT;
  const heading = feature.get('heading') || 0;
  const isBreach = feature.get('isBreach') === true;

  const styles = [];

  // Breach highlight: outer pulsing ring
  if (isBreach) {
    styles.push(
      new Style({
        image: new CircleStyle({
          radius: 18,
          fill: new Fill({ color: 'rgba(239, 68, 68, 0.15)' }),
          stroke: new Stroke({ color: '#ef4444', width: 2, lineDash: [4, 4] }),
        }),
        zIndex: 5,
      })
    );
    styles.push(
      new Style({
        image: new CircleStyle({
          radius: 24,
          fill: new Fill({ color: 'rgba(239, 68, 68, 0.05)' }),
          stroke: new Stroke({ color: 'rgba(239, 68, 68, 0.4)', width: 1 }),
        }),
        zIndex: 4,
      })
    );
  }

  // Main asset icon
  if (type === 'MARITIME') {
    // Ship shape: triangle pointing in heading direction
    styles.push(
      new Style({
        image: new RegularShape({
          points: 3,
          radius: 10,
          rotation: (heading * Math.PI) / 180,
          fill: new Fill({ color }),
          stroke: new Stroke({ color: '#fff', width: 1 }),
        }),
        zIndex: 10,
      })
    );
  } else if (type === 'AERIAL') {
    // Aircraft: diamond shape
    styles.push(
      new Style({
        image: new RegularShape({
          points: 4,
          radius: 10,
          rotation: (heading * Math.PI) / 180,
          fill: new Fill({ color }),
          stroke: new Stroke({ color: '#fff', width: 1 }),
        }),
        zIndex: 10,
      })
    );
  } else {
    // Ground / default: circle
    styles.push(
      new Style({
        image: new CircleStyle({
          radius: 7,
          fill: new Fill({ color }),
          stroke: new Stroke({ color: '#fff', width: 1.5 }),
        }),
        zIndex: 10,
      })
    );
  }

  // Callsign label
  const callsign = feature.get('callsign');
  if (callsign) {
    styles.push(
      new Style({
        text: new TextStyle({
          text: callsign,
          font: '11px system-ui, sans-serif',
          fill: new Fill({ color: '#e5e7eb' }),
          stroke: new Stroke({ color: '#000', width: 3 }),
          offsetY: -18,
        }),
        zIndex: 11,
      })
    );
  }

  return styles;
}

function createZoneStyle(feature) {
  const classification = feature.get('classification') || 'RESTRICTED';
  const config = ZONE_STYLES[classification] || ZONE_STYLES.RESTRICTED;

  return [
    new Style({
      fill: new Fill({ color: config.fill }),
      stroke: new Stroke({
        color: config.stroke,
        width: 2,
        lineDash: config.dash,
      }),
      zIndex: 1,
    }),
    // Zone label
    new Style({
      text: new TextStyle({
        text: feature.get('name') || '',
        font: 'bold 11px system-ui, sans-serif',
        fill: new Fill({ color: config.stroke }),
        stroke: new Stroke({ color: '#000', width: 3 }),
        overflow: true,
      }),
      zIndex: 2,
    }),
  ];
}

// ── Map Class ───────────────────────────────────────────────

export class GeointMap {
  constructor() {
    /** @type {Map} */
    this.map = null;

    // Sources
    this.assetSource = new VectorSource();
    this.zoneSource = new VectorSource();

    // Layers
    this.assetLayer = null;
    this.zoneLayer = null;

    // Overlay for popup
    this.popupOverlay = null;

    // State
    this._activeFilter = 'all';
    this._zonesVisible = true;
    this._selectedFeature = null;

    // Callbacks
    this._onAssetClick = null;
    this._onAlertClick = null;
  }

  /**
   * Initialize the map on a DOM element.
   * @param {string} targetId - DOM element ID
   */
  init(targetId) {
    // Base layer: dark OSM tiles
    const baseLayer = new TileLayer({
      source: new OSM({
        // Use standard OSM — in production, switch to a self-hosted dark tile server
        // for data residency compliance in Protected B environments
      }),
      className: 'ol-layer-base',
    });

    // Geofence zone layer
    this.zoneLayer = new VectorLayer({
      source: this.zoneSource,
      style: createZoneStyle,
      zIndex: 5,
      updateWhileAnimating: true,
    });

    // Asset position layer
    this.assetLayer = new VectorLayer({
      source: this.assetSource,
      style: createAssetStyle,
      zIndex: 10,
      updateWhileAnimating: true,
      updateWhileInteracting: true,
    });

    // Popup overlay
    const popupEl = document.getElementById('asset-popup');
    this.popupOverlay = new Overlay({
      element: popupEl,
      positioning: 'bottom-center',
      offset: [0, -30],
      stopEvent: false,
    });

    // Create the map
    this.map = new Map({
      target: targetId,
      layers: [baseLayer, this.zoneLayer, this.assetLayer],
      overlays: [this.popupOverlay],
      view: new View({
        center: fromLonLat([-75.0, 56.0]), // Center on Canada
        zoom: 4,
        minZoom: 2,
        maxZoom: 18,
      }),
      controls: defaultControls({
        zoom: true,
        rotate: false,
        attribution: true,
      }),
    });

    // ── Click handler ──────────────────────────────────
    this.map.on('singleclick', (evt) => {
      this._handleClick(evt);
    });

    // ── Pointer cursor on hover ────────────────────────
    this.map.on('pointermove', (evt) => {
      const pixel = this.map.getEventPixel(evt.originalEvent);
      const hit = this.map.hasFeatureAtPixel(pixel, {
        layerFilter: (layer) => layer === this.assetLayer,
      });
      this.map.getTargetElement().style.cursor = hit ? 'pointer' : '';
    });

    // ── Coordinate tracking ────────────────────────────
    this.map.on('pointermove', (evt) => {
      const [lon, lat] = toLonLat(evt.coordinate);
      const el = document.getElementById('mouse-coords');
      if (el) {
        el.textContent = `${lat.toFixed(5)}°N, ${lon.toFixed(5)}°${lon >= 0 ? 'E' : 'W'}`;
      }
    });

    // ── Zoom level tracking ────────────────────────────
    this.map.getView().on('change:resolution', () => {
      const zoom = this.map.getView().getZoom();
      const el = document.getElementById('zoom-level');
      if (el) {
        el.textContent = `Zoom: ${zoom.toFixed(1)}`;
      }
    });

    // Apply dark filter to base tiles via CSS
    this._applyDarkTheme();
  }

  /**
   * Set asset click handler.
   * @param {(assetData: object) => void} callback
   */
  onAssetClick(callback) {
    this._onAssetClick = callback;
  }

  // ── Asset Management ──────────────────────────────────────

  /**
   * Load initial asset positions onto the map.
   * @param {Array} positions - Array of position objects from the API
   */
  loadPositions(positions) {
    this.assetSource.clear();

    for (const pos of positions) {
      this._addOrUpdateAssetFeature(pos);
    }
  }

  /**
   * Update a single asset's position (from WebSocket).
   * Creates the feature if it doesn't exist.
   * @param {object} positionData
   */
  updateAssetPosition(positionData) {
    this._addOrUpdateAssetFeature(positionData);
  }

  /**
   * Mark an asset as having breached a geofence.
   * @param {string} assetId
   * @param {boolean} breached
   */
  setAssetBreach(assetId, breached) {
    const feature = this.assetSource.getFeatureById(assetId);
    if (feature) {
      feature.set('isBreach', breached);
      feature.changed(); // Force re-render
    }
  }

  _addOrUpdateAssetFeature(pos) {
    const id = pos.assetId || pos.asset_id;
    let feature = this.assetSource.getFeatureById(id);

    const coords = fromLonLat([pos.longitude, pos.latitude]);

    if (feature) {
      // Update existing
      feature.getGeometry().setCoordinates(coords);
      feature.set('heading', pos.heading_deg);
      feature.set('speed', pos.speed_knots);
      feature.set('altitude', pos.altitude_m);
      feature.set('source', pos.source);
      feature.set('reportedAt', pos.reported_at);
      feature.set('longitude', pos.longitude);
      feature.set('latitude', pos.latitude);
    } else {
      // Create new
      feature = new Feature({
        geometry: new Point(coords),
        assetId: id,
        callsign: pos.callsign,
        assetType: pos.asset_type || pos.assetType,
        heading: pos.heading_deg,
        speed: pos.speed_knots,
        altitude: pos.altitude_m,
        source: pos.source,
        reportedAt: pos.reported_at,
        longitude: pos.longitude,
        latitude: pos.latitude,
        isBreach: false,
      });
      feature.setId(id);
      this.assetSource.addFeature(feature);
    }

    // Apply filter visibility
    this._applyFilterToFeature(feature);
  }

  // ── Zone Management ───────────────────────────────────────

  /**
   * Load geofence zones onto the map.
   * @param {Array} zones - Array of zone objects with geojson property
   */
  loadZones(zones) {
    this.zoneSource.clear();
    const geoJsonFormat = new GeoJSON();

    for (const zone of zones) {
      if (!zone.geojson) continue;

      const geojsonFeature = {
        type: 'Feature',
        geometry: zone.geojson,
        properties: {},
      };

      const features = geoJsonFormat.readFeatures(geojsonFeature, {
        featureProjection: 'EPSG:3857',
      });

      for (const feature of features) {
        feature.setId(zone.id);
        feature.set('name', zone.name);
        feature.set('classification', zone.classification);
        feature.set('zoneId', zone.id);
        feature.set('alertSeverity', zone.alert_severity);
        feature.set('isActive', zone.is_active);
        this.zoneSource.addFeature(feature);
      }
    }
  }

  /**
   * Toggle zone layer visibility.
   */
  toggleZones() {
    this._zonesVisible = !this._zonesVisible;
    this.zoneLayer.setVisible(this._zonesVisible);
    return this._zonesVisible;
  }

  // ── Filtering ─────────────────────────────────────────────

  /**
   * Filter visible assets by type.
   * @param {string} type - 'all' | 'MARITIME' | 'AERIAL' | 'GROUND'
   */
  setAssetFilter(type) {
    this._activeFilter = type;

    this.assetSource.getFeatures().forEach((feature) => {
      this._applyFilterToFeature(feature);
    });
  }

  _applyFilterToFeature(feature) {
    if (this._activeFilter === 'all') {
      feature.setStyle(undefined); // Use layer style
    } else if (feature.get('assetType') !== this._activeFilter) {
      feature.setStyle(new Style({})); // Invisible
    } else {
      feature.setStyle(undefined); // Use layer style
    }
  }

  // ── Interaction ───────────────────────────────────────────

  _handleClick(evt) {
    const feature = this.map.forEachFeatureAtPixel(evt.pixel, (f) => f, {
      layerFilter: (layer) => layer === this.assetLayer,
    });

    if (feature) {
      const coords = feature.getGeometry().getCoordinates();
      this.popupOverlay.setPosition(coords);

      // Populate popup
      const popupEl = document.getElementById('asset-popup');
      popupEl.hidden = false;

      document.getElementById('popup-callsign').textContent = feature.get('callsign') || '—';
      document.getElementById('popup-type').textContent = feature.get('assetType') || '—';
      document.getElementById('popup-type').className = `badge ${feature.get('assetType') || ''}`;
      document.getElementById('popup-coords').textContent =
        `${(feature.get('latitude') || 0).toFixed(5)}°, ${(feature.get('longitude') || 0).toFixed(5)}°`;
      document.getElementById('popup-heading').textContent =
        feature.get('heading') != null ? `${feature.get('heading').toFixed(1)}°` : '—';
      document.getElementById('popup-speed').textContent =
        feature.get('speed') != null ? `${feature.get('speed').toFixed(1)} kn` : '—';
      document.getElementById('popup-altitude').textContent =
        feature.get('altitude') != null ? `${feature.get('altitude').toFixed(0)} m` : '—';
      document.getElementById('popup-source').textContent = feature.get('source') || '—';
      document.getElementById('popup-time').textContent = feature.get('reportedAt')
        ? new Date(feature.get('reportedAt')).toLocaleTimeString()
        : '—';

      this._selectedFeature = feature;

      if (this._onAssetClick) {
        this._onAssetClick({
          assetId: feature.get('assetId'),
          callsign: feature.get('callsign'),
        });
      }
    } else {
      // Click on empty map — close popup
      document.getElementById('asset-popup').hidden = true;
      this.popupOverlay.setPosition(undefined);
      this._selectedFeature = null;
    }
  }

  // ── View Controls ─────────────────────────────────────────

  /**
   * Fit the view to show all assets.
   */
  fitAllAssets() {
    const extent = this.assetSource.getExtent();
    if (extent && isFinite(extent[0])) {
      this.map.getView().fit(extent, {
        padding: [80, 80, 80, 80],
        maxZoom: 12,
        duration: 800,
      });
    }
  }

  /**
   * Center on a specific asset.
   * @param {string} assetId
   */
  centerOnAsset(assetId) {
    const feature = this.assetSource.getFeatureById(assetId);
    if (feature) {
      this.map.getView().animate({
        center: feature.getGeometry().getCoordinates(),
        zoom: 12,
        duration: 600,
      });
    }
  }

  /**
   * Center on a specific coordinate.
   * @param {number} lon
   * @param {number} lat
   * @param {number} [zoom=12]
   */
  centerOn(lon, lat, zoom = 12) {
    this.map.getView().animate({
      center: fromLonLat([lon, lat]),
      zoom,
      duration: 600,
    });
  }

  // ── Theme ─────────────────────────────────────────────────

  _applyDarkTheme() {
    // Apply CSS filter to darken OpenStreetMap tiles for military aesthetic
    const style = document.createElement('style');
    style.textContent = `
      .ol-layer-base canvas {
        filter: brightness(0.45) contrast(1.2) saturate(0.3) hue-rotate(180deg) invert(1);
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Get feature count.
   */
  getAssetCount() {
    return this.assetSource.getFeatures().length;
  }
}

export default new GeointMap();
