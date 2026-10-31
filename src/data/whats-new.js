// Release notes for the "What's new" pop-up, newest first. A new `id` shows the dot again for
// everyone who hasn't opened it yet; fixes not worth announcing just don't get an entry.
// The newest release's `version` shows in the site footer.
// `notice` is optional: a highlighted heading and line for that release's biggest news.
export const RELEASES = [
  {
    id: "2026-10",
    version: "2026.10.30",
    date: "October 2026",
    notice: { heading: "This is the NEW SounderPy App!", text: "Update your bookmarks to sounderpy.app" },
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
