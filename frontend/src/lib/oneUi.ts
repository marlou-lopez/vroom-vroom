// EXPERIMENTAL overhaul prototype flag (vroom-pnw.58): `?ui=one` shows the one-app layout instead of the current UI.
export const oneUiEnabled = (params: URLSearchParams) => params.get("ui") === "one";
