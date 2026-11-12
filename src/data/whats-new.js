// Release notes for the "What's new" pop-up, newest first. A new `id` shows the dot again for
// everyone who hasn't opened it yet; fixes not worth announcing just don't get an entry.
// The newest release's `version` shows in the site footer.
// `notice` is optional: a highlighted heading and line for that release's biggest news.
export const RELEASES = [

  {
    id: "2026-11-11",
    version: "2026.11.11",
    date: "November 11th, 2026",
    notice: { heading: "This is the NEW SounderPy App!", text: "Update your bookmarks to sounderpy.app" },
    items: [
      "Winter Soundings: in figure settings you can toggle the sounding mode to 'winter', returning a winter-focused sounding.",
      "New RAOB map: a new global master list of WMO/ICAO/IGRAv2 sites, complied from NCAR, WMO, Unv. of Wyoming, and IGRAv2 datasets, supports a new RAOB station map with status, POR, and source information",
      "All RAOB sources: the web app now supports fetching observations with WMO, ICAO, and IGRAv2 IDs. IRGAv2 retrieval was optimized.",
      "Improved RAP-RUC parsing: a bug preventing thredding GRIB parsing has been fixed, supporting composite plots of RAP-RUC renalysis."
    ],
  },

  {
    id: "2026-11-04",
    version: "2026.11.04",
    date: "November 4th, 2026",
    items: [
      "Support for RRFS forecasts: Rapid Refresh Forecast System model profiles are available through BUFKIT.",
      "Update to v3.3.0 figures: a beta version of the coming full SounderPy release, with updated figures and figure settings, is deployed for the web app.",
    ],
  },

  {
    id: "2026-11-02",
    version: "2026.11.02",
    date: "November 2nd, 2026",
    items: [
      "Custom Soundings: capability to upload and plot custom SHARPpy (.txt, .sharppy) and CM1 input_sounding (.txt, .snd, or no extension), soundings. Max upload is 1 MB. Plots are fully customizable.",
      "Mobile: improved mobile experience.",
    ],
  },

  {
    id: "2026-10-30",
    version: "2026.10.30",
    date: "October 30th, 2026",
    items: [
      "Composite soundings (experimental): overlay up to 6 profiles of any data type, such as forecast timeseries",
      "Recent RAOB launches: the RAOb station site map now shows (sortable) recent launch times. Available profiles, based on date/time inputs, will update on the map.",
      "Maps: An improved station ID maps",
      "Faster repeat requests: recently fetched RAOB, ACARS, and BUFKIT profiles are cached on the server for faster future requests.",
      "Sounding zoom: click your sounding to zoom in,  copy the image to your clipboard, or save",
      "Sounding sharing: share the link to any sounding. Anyone who opens the link can create the same sounding.",
	"Setting saving: you can have your favorite figure settings saved for your next vist.",
    ],
  },
];
