import { BufferAttribute, BufferGeometry, Group, LinearMipmapLinearFilter, Mesh, MeshBasicMaterial, SRGBColorSpace, Texture, type WebGLRenderer } from "three";
import { buildGroundTile, buildTerrain, textureBytes, loadTerrain, type GroundManifest, type GroundTile, type TerrainGrid, type TrackLines } from "./ground";

const PARALLEL = 4;
const ANISOTROPY = 8;
/** The photo is darkened a little, so the lines and badges stay readable on it. */
const TINT = 0.85;

export interface GroundScene extends TrackLines { heights: Float64Array }

/** The ground beside the track (vroom-ueg.9): one mesh per tile. Textures stay when the lap changes, only the meshes are rebuilt. */
export class GroundLayer {
  readonly group = new Group();
  private readonly meshes = new Map<string, Mesh<BufferGeometry, MeshBasicMaterial>>();
  private readonly loaded: GroundTile[] = [];
  private readonly abort = new AbortController();
  private scene: GroundScene | null = null;
  private terrain: ReturnType<typeof buildTerrain> | null = null;
  /** The terrain model's heights, once read; the ground follows the track heights until then or without them. */
  private grid: TerrainGrid | null = null;
  private gridFailed = false;
  private geometryBytes = 0;
  private readonly gl: WebGLRenderer;
  private readonly manifest: GroundManifest;
  private readonly onNeedsDraw: () => void;

  constructor(gl: WebGLRenderer, manifest: GroundManifest, baseUrl: string, onNeedsDraw: () => void) {
    this.gl = gl;
    this.manifest = manifest;
    this.onNeedsDraw = onNeedsDraw;
    const queue = [...manifest.tiles];
    for (let i = 0; i < PARALLEL; i++) void this.run(queue, baseUrl);
    if (manifest.terrain) {
      void loadTerrain(baseUrl, manifest.terrain, this.abort.signal).then((g) => {
        if (this.abort.signal.aborted) return;
        if (!g) this.gridFailed = true; // the file is not usable: the ground follows the track heights, as without it
        this.grid = g;
        if (this.scene) this.setScene(this.scene);
        this.onNeedsDraw();
      });
    }
  }

  /** Rebuilds the meshes for a comparison's centreline and edges. */
  setScene(s: GroundScene) {
    this.scene = s;
    if (this.manifest.terrain && !this.grid && !this.gridFailed) return; // wait for the terrain file: no height computing in the meantime
    const { tiles, tile_m, reach_m } = this.manifest;
    this.terrain = buildTerrain(s, s.heights, tiles, tile_m, reach_m, this.grid);
    this.geometryBytes = 0;
    for (const t of this.loaded) this.shape(t);
  }

  stats() {
    return { tiles: this.loaded.length, of: this.manifest.tiles.length, textureMB: textureBytes(this.loaded) / 1e6, meshMB: this.geometryBytes / 1e6 };
  }

  dispose() {
    this.abort.abort();
    this.group.removeFromParent();
    for (const m of this.meshes.values()) {
      m.geometry.dispose();
      (m.material.map?.image as ImageBitmap | undefined)?.close();
      m.material.map?.dispose();
      m.material.dispose();
    }
    this.meshes.clear();
  }

  private async run(queue: GroundTile[], baseUrl: string) {
    const { signal } = this.abort;
    for (let t = queue.shift(); t && !signal.aborted; t = queue.shift()) {
      try {
        const res = await fetch(baseUrl + t.file, { signal });
        if (!res.ok) continue;
        const image = await createImageBitmap(await res.blob());
        if (signal.aborted) { image.close(); return; }
        this.add(t, image);
      } catch {
        // A tile that cannot be loaded stays empty.
      }
    }
  }

  private add(t: GroundTile, image: ImageBitmap) {
    const map = new Texture(image);
    map.flipY = false;
    map.colorSpace = SRGBColorSpace;
    map.minFilter = LinearMipmapLinearFilter;
    map.anisotropy = Math.min(ANISOTROPY, this.gl.capabilities.getMaxAnisotropy());
    map.needsUpdate = true;
    this.gl.initTexture(map); // one upload per loaded tile, not all in one frame
    const mat = new MeshBasicMaterial({
      map, vertexColors: true, transparent: true, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 4,
    });
    mat.color.setScalar(TINT);
    const mesh = new Mesh(new BufferGeometry(), mat);
    mesh.renderOrder = -0.5; // after the sky dome, before everything else that is transparent (the ghost car)
    this.meshes.set(t.file, mesh);
    this.loaded.push(t);
    this.group.add(mesh);
    this.shape(t);
    this.onNeedsDraw();
  }

  private shape(t: GroundTile) {
    const mesh = this.meshes.get(t.file);
    if (!mesh || !this.scene || !this.terrain) return;
    const d = buildGroundTile(t, this.manifest.tile_m, this.terrain, this.scene.origin);
    mesh.geometry.dispose();
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(d.positions, 3));
    g.setAttribute("uv", new BufferAttribute(d.uvs, 2));
    g.setAttribute("color", new BufferAttribute(d.colors, 4));
    g.setIndex(new BufferAttribute(d.indices, 1));
    g.computeBoundingSphere();
    mesh.geometry = g;
    mesh.visible = d.indices.length > 0;
    this.geometryBytes += d.positions.byteLength + d.uvs.byteLength + d.colors.byteLength + d.indices.byteLength;
  }
}
