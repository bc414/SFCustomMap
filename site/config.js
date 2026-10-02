// Edit these defaults to change what the map shows on first load.
// Everything here can also be changed from the panel on the page; those
// changes are kept in the URL, so a link reproduces the same view.
window.MAP_CONFIG = {
  // Where you are staying. You can also drag the home marker on the map.
  home: { lat: 37.76665, lon: -122.39465, label: "Potrero 1010 (1010 16th St)" },

  // Stops within this many meters of home are used as starting stops.
  homeRadiusM: 500,

  // Explicit starting stops (GTFS stop_ids). Leave empty to use every stop
  // within homeRadiusM. Stops can also be added/removed by clicking them.
  startStops: [],

  // Walking radius drawn around every stop you can ride to, in meters.
  walkRadiusM: 400,

  // Default service window (minutes after midnight). A route counts only if
  // it leaves a starting stop at least once in this window.
  timeFrom: 7 * 60,
  timeTo: 22 * 60,

  // "palette": distinct colors per route (easiest to tell apart).
  // "muni": the colors published in the Muni GTFS feed, where present.
  colorMode: "palette",

  // Shading for the shared reachable area.
  reachColor: "#3b5ba5",
  reachOpacity: 0.22,
};
