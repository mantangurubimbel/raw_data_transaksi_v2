/**
 * Web App: dashboard Revenue per Branch.
 *
 * Sumber data: sheet "[Use] Raw Txn". Kolom dicari berdasarkan nama header di baris 1,
 * jadi urutan kolom / kolom formula tambahan tidak berpengaruh.
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

  return aggregateByBranch_(values, col, filters || {}, ss.getSpreadsheetTimeZone());
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

/**
 * Agregasi pure (tanpa akses Spreadsheet) supaya mudah diuji.
 * @return {{branches:Array, totals:Object, options:Object}}
 */
function aggregateByBranch_(values, col, filters, timeZone) {
  var from = filters.from || '';
  var to = filters.to || '';
  var ay = filters.academicYear || '';
  var pt = filters.productType || '';

  var dateCache = {};
  var byBranch = {};
  var ayOpts = {};
  var ptOpts = {};
  var minDate = '';
  var maxDate = '';
  var totalRevenue = 0;
  var totalTxn = 0;

  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    var branch = String(row[col.branch]).trim();
    if (!branch) continue; // baris kosong

    var rowAy = String(row[col.academicYear]).trim();
    var rowPt = String(row[col.productType]).trim();
    var d = toIsoDate_(row[col.date], timeZone, dateCache);
    if (rowAy) ayOpts[rowAy] = true;
    if (rowPt) ptOpts[rowPt] = true;
    if (d) {
      if (!minDate || d < minDate) minDate = d;
      if (!maxDate || d > maxDate) maxDate = d;
    }

    if (ay && rowAy !== ay) continue;
    if (pt && rowPt !== pt) continue;
    if (from && (!d || d < from)) continue;
    if (to && (!d || d > to)) continue;

    var rev = Number(row[col.revenue]) || 0;
    var b = byBranch[branch] || (byBranch[branch] = { branch: branch, revenue: 0, txn: 0 });
    b.revenue += rev;
    b.txn += 1;
    totalRevenue += rev;
    totalTxn += 1;
  }

  var branches = Object.keys(byBranch).map(function (k) { return byBranch[k]; });
  branches.sort(function (a, b) { return b.revenue - a.revenue || a.branch.localeCompare(b.branch); });

  return {
    branches: branches,
    totals: { revenue: totalRevenue, txn: totalTxn, branches: branches.length },
    options: {
      academicYears: Object.keys(ayOpts).sort(),
      productTypes: Object.keys(ptOpts).sort(),
      minDate: minDate,
      maxDate: maxDate
    },
    generatedAt: new Date().toISOString()
  };
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
