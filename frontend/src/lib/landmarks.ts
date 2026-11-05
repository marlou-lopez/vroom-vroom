import type { LandmarkConfidence } from "../api/types";
import { colors } from "../theme";

export const landmarkFill = (c: LandmarkConfidence): string => (c === "confirmed" ? colors.you : c === "detected" ? colors.strength : "none");
export const landmarkStroke = (c: LandmarkConfidence): string => (c === "low" ? colors.muted : landmarkFill(c));
