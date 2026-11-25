// Where the track edges come from in the detailed 2D view, remembered; the 3D view follows its "aerial" choice (vroom-ueg.8).
import type { EdgeSource } from "../detailed/scene";
import { loadSetting, saveSetting } from "./storage";

const EDGES_KEY = "vroom.edges";
const EDGE_SOURCES: readonly EdgeSource[] = ["stand-in", "telemetry", "aerial"];

export const loadEdgeSource = (): EdgeSource => loadSetting(EDGES_KEY, EDGE_SOURCES, "stand-in");
export const saveEdgeSource = (v: EdgeSource) => saveSetting(EDGES_KEY, v);
