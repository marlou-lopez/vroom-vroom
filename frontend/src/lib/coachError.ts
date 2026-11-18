/** A plain sentence for a coach failure, never the raw `code: message`. The server's message is kept for the tooltip only. */
export function plainCoachError(code: string): string {
  switch (code) {
    case "network": return "Couldn't reach the coach. Check that the app is running, then retry.";
    case "missing_api_key": return "The coach has no API key set up, so it can't analyze yet.";
    case "llm_error": return "The coach's model didn't answer. Try again in a moment.";
    case "invalid_output": return "The coach gave an answer the app couldn't use. Try again.";
    case "no_reference": return "There is no best lap for this car and track yet, so there is nothing to compare against.";
    case "not_enough_laps": return "Checking consistency needs more valid laps in this session.";
    case "no_valid_laps": return "This session has no valid laps to analyze.";
    case "track_mismatch": return "These two laps are from different tracks, so they can't be compared.";
    case "unknown_lap": return "That lap no longer exists.";
    default: return "Something went wrong while analyzing. Try again.";
  }
}
