global.window = global;
['./js/csv-util.js', './js/sos-config.js', './js/sos-parser.js', './js/sos-analytics.js']
  .forEach(function (f) { require(f); });
var fs = require('fs');
var out = SOS_PARSER.parse(fs.readFileSync('sample-data/Template SOS_Download Web CAT.csv', 'utf8'));
var keys = ['wear_fe', 'wear_cu', 'wear_si', 'wear_al', 'additive_na', 'pqi', 'visc_v100'];

function tally(label, list, get) {
  var c = {};
  keys.forEach(function (k) { c[k] = 0; });
  list.forEach(function (o) { keys.forEach(function (k) { if (get(o)[k] != null) c[k]++; }); });
  console.log(label + ' (' + list.length + '): ' + keys.map(function (k) { return k + '=' + c[k]; }).join('  '));
}

tally('SAMPEL hasil parse', out.samples, function (s) { return s; });

var an = SOS_ANALYTICS.analyze(out.samples);
var units = Object.keys(an.units).map(function (k) { return an.units[k]; });
tally('UNIT.latest        ', units, function (u) { return u.latest; });

var fd = units.filter(function (u) { return /FINAL DRIVE/i.test(u.component); });
if (fd.length) tally('FINAL DRIVE .latest', fd, function (u) { return u.latest; });
var eng = units.filter(function (u) { return /ENGINE/i.test(u.component); });
if (eng.length) tally('ENGINE .latest     ', eng, function (u) { return u.latest; });

var u0 = eng[0] || units[0];
console.log('\ncontoh: ' + u0.assetId + ' / ' + u0.component);
keys.forEach(function (k) { console.log('  ' + k + ' = ' + JSON.stringify(u0.latest[k])); });
console.log('  _invalidParams = ' + JSON.stringify(u0.latest._invalidParams));
