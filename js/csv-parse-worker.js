/* Parser worker for large uploads. */
'use strict';
self.onmessage = function (event) {
  var job = event.data || {};
  try {
    if (job.kind === 'sos') {
      // Parser modules delegate CSV splitting and number conversion to the
      // shared utility. Workers do not inherit the page's script globals, so
      // load the dependency explicitly before loading the parser.
      importScripts('csv-util.js', 'sos-config.js', 'sos-parser.js');
      var sos = self.SOS_PARSER.parse(job.text);
      sos.meta = sos.meta || {};
      sos.meta.fileName = job.fileName || '';
      self.postMessage({ ok: true, result: sos });
    } else if (job.kind === 'vhms') {
      // VHMS parser also uses CSV_UTIL and profile detection at parse time.
      importScripts('csv-util.js', 'vhms-config.js', 'vhms-profiles.js', 'vhms-parser.js');
      var vhms = self.VHMS_PARSER.parse(job.text);
      vhms.meta = vhms.meta || {};
      vhms.meta.fileName = job.fileName || '';
      self.postMessage({ ok: true, result: vhms });
    } else {
      self.postMessage({ ok: false, error: 'Jenis parser worker tidak dikenal.' });
    }
  } catch (error) {
    self.postMessage({ ok: false, error: error && error.message ? error.message : String(error) });
  }
};