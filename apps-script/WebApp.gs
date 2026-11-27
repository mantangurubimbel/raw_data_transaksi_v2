/**
 * Web App: dashboard Revenue per Branch.
 *
 * Sumber data: sheet "[Use] Raw Txn". Kolom dicari berdasarkan nama header di baris 1,
 * jadi urutan kolom / kolom formula tambahan tidak berpengaruh.
 *
 * Perbandingan YoY: jika Academic Year dipilih (mis. 26/27) dan Academic Year sebelumnya
 * (25/26) ada di data, capaian dibandingkan pada periode tanggal yang sama digeser 1 tahun.
 * Tanggal akhir = filter "Sampai tanggal", atau tanggal Payment Date terakhir di tabel.
 *
 * Deploy: Deploy > New deployment > Web app
 *   - Execute as: Me
 *   - Who has access: Anyone within <domain> (atau sesuai kebutuhan)
 */

var WEB_CONFIG = {
  SPREADSHEET_ID: '1dr_R9sRCCFkTBZv7CIyDlu5UfEOWOCQa7kZ-ofbEur8',
  SHEET: '[Use] Raw Txn',
  HEADERS: {
    date: 'Payment Date',
    branch: 'Cluster',
    revenue: 'Revenue',
    academicYear: 'Academic Year',
    productType: 'New Product Type'
  }
};

var WEB_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function doGet() {
  return HtmlService.createTemplateFromFile('Dashboard')
    .evaluate()
    .setTitle('Revenue per Branch')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Dipanggil dari Dashboard.html.
 * @param {{from?:string, to?:string, academicYear?:string, productType?:string}} filters
 *        from/to format yyyy-mm-dd (inklusif). String kosong = semua.
 */
function getDashboardData(filters) {
  var ss = SpreadsheetApp.openById(WEB_CONFIG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName(WEB_CONFIG.SHEET);
  if (!sheet) throw new Error('Sheet "' + WEB_CONFIG.SHEET + '" tidak ditemukan.');

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  var header = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  var col = resolveColumns_(header);
  var values = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];

  return buildDashboard_(values, col, filters || {}, ss.getSpreadsheetTimeZone());
}

/** Cari index kolom berdasarkan nama header (case-insensitive). */
function resolveColumns_(header) {
  var norm = header.map(function (h) { return String(h).trim().toLowerCase(); });
  var col = {};
  var missing = [];
  Object.keys(WEB_CONFIG.HEADERS).forEach(function (key) {
    var i = norm.indexOf(WEB_CONFIG.HEADERS[key].toLowerCase());
    if (i < 0) missing.push(WEB_CONFIG.HEADERS[key]);
    col[key] = i;
  });
  if (missing.length) {
    throw new Error('Kolom tidak ditemukan di "' + WEB_CONFIG.SHEET + '": ' + missing.join(', '));
  }
  return col;
}

/* ------------------------------------------------------------------ */
/* Agregasi (pure, tanpa akses Spreadsheet, supaya mudah diuji)        */
/* ------------------------------------------------------------------ */

function buildDashboard_(values, col, filters, timeZone) {
  var from = filters.from || '';
  var to = filters.to || '';
  var ay = filters.academicYear || '';
  var pt = filters.productType || '';

  // Pass 1: normalisasi baris + kumpulkan opsi filter.
  var dateCache = {};
  var rows = [];
  var ayOpts = {};
  var ptOpts = {};
  var minDate = '';
  var maxDate = '';
  for (var r = 0; r < values.length; r++) {
    var v = values[r];
    var branch = String(v[col.branch]).trim();
    if (!branch) continue; // baris kosong
    var row = {
      branch: branch,
      date: toIsoDate_(v[col.date], timeZone, dateCache),
      ay: String(v[col.academicYear]).trim(),
      pt: String(v[col.productType]).trim(),
      revenue: Number(v[col.revenue]) || 0
    };
    rows.push(row);
    if (row.ay) ayOpts[row.ay] = true;
    if (row.pt) ptOpts[row.pt] = true;
    if (row.date) {
      if (!minDate || row.date < minDate) minDate = row.date;
      if (!maxDate || row.date > maxDate) maxDate = row.date;
    }
  }

  // Tentukan periode pembanding.
  var prevAy = ay ? previousAcademicYear_(ay) : '';
  var comparison = { enabled: false, academicYear: ay, prevAcademicYear: prevAy };
  if (!ay) {
    comparison.reason = 'Pilih Academic Year untuk melihat perbandingan dengan tahun sebelumnya.';
  } else if (!prevAy || !ayOpts[prevAy]) {
    comparison.reason = 'Data Academic Year ' + (prevAy || 'sebelumnya') + ' tidak tersedia, perbandingan tidak ditampilkan.';
  } else {
    var cutoff = to || maxDate;
    comparison.enabled = true;
    comparison.from = from;
    comparison.to = cutoff;
    comparison.toIsLatestData = !to;
    comparison.prevFrom = from ? shiftYear_(from, -1) : '';
    comparison.prevTo = shiftYear_(cutoff, -1);
  }

  // Pass 2: agregasi.
  var byBranch = {};
  var totals = { revenue: 0, txn: 0, prevRevenue: 0, prevTxn: 0 };
  var trendCur = {};
  var trendPrev = {};

  function branchOf(name) {
    return byBranch[name] || (byBranch[name] = { branch: name, revenue: 0, txn: 0, prevRevenue: 0, prevTxn: 0 });
  }

  for (var i = 0; i < rows.length; i++) {
    var x = rows[i];
    if (pt && x.pt !== pt) continue;

    // Periode berjalan (filter apa adanya; jika perbandingan aktif, dibatasi s/d cutoff).
    var curTo = comparison.enabled ? comparison.to : to;
    if ((!ay || x.ay === ay) && inRange_(x.date, from, curTo)) {
      var b = branchOf(x.branch);
      b.revenue += x.revenue;
      b.txn += 1;
      totals.revenue += x.revenue;
      totals.txn += 1;
      addTrend_(trendCur, x, ay);
    } else if (comparison.enabled && x.ay === prevAy && inRange_(x.date, comparison.prevFrom, comparison.prevTo)) {
      var p = branchOf(x.branch);
      p.prevRevenue += x.revenue;
      p.prevTxn += 1;
      totals.prevRevenue += x.revenue;
      totals.prevTxn += 1;
      addTrend_(trendPrev, x, prevAy);
    }
  }

  var branches = Object.keys(byBranch).map(function (k) { return byBranch[k]; });
  branches.sort(function (a, b) {
    return b.revenue - a.revenue || b.prevRevenue - a.prevRevenue || a.branch.localeCompare(b.branch);
  });
  totals.branches = branches.filter(function (b) { return b.txn > 0; }).length;

  return {
    branches: branches,
    totals: totals,
    comparison: comparison,
    trend: buildTrend_(trendCur, comparison.enabled ? trendPrev : null, ay),
    options: {
      academicYears: Object.keys(ayOpts).sort(),
      productTypes: Object.keys(ptOpts).sort(),
      minDate: minDate,
      maxDate: maxDate
    },
    generatedAt: new Date().toISOString()
  };
}

function inRange_(date, from, to) {
  if (!from && !to) return true;
  if (!date) return false;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

/**
 * Kumpulkan revenue per bulan Payment Date.
 * Jika Academic Year diketahui, kunci = offset bulan dari Juli tahun awal AY
 * (Jul = 0), sehingga tahun ini & tahun lalu sejajar per bulan.
 * Jika tidak, kunci = "yyyy-mm" kronologis.
 */
function addTrend_(bucket, row, ay) {
  if (!row.date) return;
  var y = Number(row.date.substring(0, 4));
  var m = Number(row.date.substring(5, 7)) - 1;
  var key;
  var start = ay ? academicYearStart_(ay) : null;
  if (start !== null) {
    key = (y - start) * 12 + (m - 6);
  } else {
    key = row.date.substring(0, 7);
  }
  bucket[key] = (bucket[key] || 0) + row.revenue;
}

function buildTrend_(cur, prev, ay) {
  var start = ay ? academicYearStart_(ay) : null;
  if (start === null) {
    var keys = Object.keys(cur).sort();
    return {
      labels: keys.map(function (k) { return WEB_MONTHS[Number(k.substring(5, 7)) - 1] + ' ' + k.substring(2, 4); }),
      current: keys.map(function (k) { return cur[k]; }),
      previous: null
    };
  }
  var offsets = Object.keys(cur).concat(prev ? Object.keys(prev) : []).map(Number);
  if (!offsets.length) return { labels: [], current: [], previous: prev ? [] : null };
  var lo = Math.min.apply(null, offsets);
  var hi = Math.max.apply(null, offsets);
  var labels = [];
  var c = [];
  var p = [];
  for (var o = lo; o <= hi; o++) {
    labels.push(WEB_MONTHS[(((o + 6) % 12) + 12) % 12]);
    c.push(Object.prototype.hasOwnProperty.call(cur, o) ? cur[o] : null);
    p.push(prev && Object.prototype.hasOwnProperty.call(prev, o) ? prev[o] : null);
  }
  return { labels: labels, current: c, previous: prev ? p : null };
}

/** "26/27" -> 2026, "2026/2027" -> 2026, selain itu null. */
function academicYearStart_(ay) {
  var m = String(ay).trim().match(/^(\d{2}|\d{4})\s*\/\s*(\d{2}|\d{4})$/);
  if (!m) return null;
  var y = Number(m[1]);
  return m[1].length === 2 ? 2000 + y : y;
}

/** "26/27" -> "25/26", "2026/2027" -> "2025/2026", selain itu ''. */
function previousAcademicYear_(ay) {
  var m = String(ay).trim().match(/^(\d{2}|\d{4})\s*\/\s*(\d{2}|\d{4})$/);
  if (!m) return '';
  var len1 = m[1].length;
  var len2 = m[2].length;
  var mod1 = len1 === 2 ? 100 : 10000;
  var mod2 = len2 === 2 ? 100 : 10000;
  var a = (Number(m[1]) - 1 + mod1) % mod1;
  var b = (Number(m[2]) - 1 + mod2) % mod2;
  return pad_(a, len1) + '/' + pad_(b, len2);
}

function pad_(n, len) {
  var s = String(n);
  while (s.length < len) s = '0' + s;
  return s;
}

/** Geser "yyyy-mm-dd" sebanyak n tahun; 29 Feb -> 28 Feb bila perlu. */
function shiftYear_(iso, n) {
  var y = Number(iso.substring(0, 4)) + n;
  var m = Number(iso.substring(5, 7));
  var d = Number(iso.substring(8, 10));
  var last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return y + '-' + pad_(m, 2) + '-' + pad_(Math.min(d, last), 2);
}

/** Date object / serial / string "yyyy-mm-dd" -> "yyyy-mm-dd" (atau '' jika tidak valid). */
function toIsoDate_(v, timeZone, cache) {
  if (v instanceof Date) {
    var key = v.getTime();
    if (!cache.hasOwnProperty(key)) cache[key] = Utilities.formatDate(v, timeZone, 'yyyy-MM-dd');
    return cache[key];
  }
  if (typeof v === 'number') {
    return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000).toISOString().slice(0, 10);
  }
  var m = String(v).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[1] + '-' + m[2] + '-' + m[3] : '';
}
