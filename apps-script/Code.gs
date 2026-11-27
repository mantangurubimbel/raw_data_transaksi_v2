/**
 * Import CSV transaksi ke sheet "Raw Txn".
 *
 * Alur:
 *   1. Menu "Import Transaksi" > "Upload CSV ke Raw Txn" membuka dialog (Upload.html).
 *   2. Browser membaca & mem-parse CSV, lalu hanya mengirim kolom yang dibutuhkan
 *      (CONFIG.CSV_COLUMNS) ke fungsi server importRawTxn() supaya payload kecil.
 *   3. Server memvalidasi & mentransformasi semua baris, termasuk lookup ke sheet
 *      Validation. Jika ada error, proses dibatalkan dan "Raw Txn" TIDAK disentuh.
 *   4. Isi "Raw Txn" baris 2 ke bawah pada kolom 1..18 dikosongkan (kolom formula di
 *      kanannya tidak disentuh), lalu data baru ditulis per batch.
 */

var CONFIG = {
  TARGET_SHEET: 'Raw Txn',
  VALIDATION_SHEET: 'Validation',
  WRITE_BATCH_ROWS: 5000,

  // Kolom yang diambil dari CSV (dicocokkan berdasarkan nama header).
  CSV_COLUMNS: [
    'Payment Date',
    'Month',
    'Invoice',
    'User ID',
    'User Email',
    'Class Name',
    'Package Category',
    'New Product Type',
    'Agent Name',
    'Product Cluster',
    'Cluster',
    'Payment Category',
    'Payment Option',
    'Academic Year',
    'Renewal Status',
    'school_npsn',
    'Revenue'
  ],

  // Urutan kolom = urutan header di baris 1 sheet "Raw Txn" (kolom A..R).
  TARGET_COLUMNS: [
    'Payment Date',
    'Month',
    'Invoice',
    'User ID',
    'User Email',
    'Class Name',
    'Package Category',
    'New Product Type',
    'Agent Name',
    'Product Cluster',
    'Cluster',
    'Payment Category',
    'Payment Option',
    'Academic Year',
    'Renewal Status',
    'school_npsn',
    'Revenue',
    'Grade'
  ],

  // Lookup ke sheet Validation (header di baris 1, pencocokan case-insensitive).
  PRODUCT_TYPE_LOOKUP: { key: 'New Product Type', value: 'New Product Type Edited' },
  GRADE_LOOKUP: { key: 'Kelas', value: 'Grade' }
};

var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ------------------------------------------------------------------ */
/* Menu & dialog                                                       */
/* ------------------------------------------------------------------ */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Import Transaksi')
    .addItem('Upload CSV ke Raw Txn', 'showUploadDialog')
    .addToUi();
}

function showUploadDialog() {
  var html = HtmlService.createTemplateFromFile('Upload');
  html.columns = CONFIG.CSV_COLUMNS;
  SpreadsheetApp.getUi().showModalDialog(
    html.evaluate().setWidth(520).setHeight(400),
    'Upload CSV ke Raw Txn'
  );
}

/* ------------------------------------------------------------------ */
/* Entry point dipanggil dari Upload.html                              */
/* ------------------------------------------------------------------ */

/**
 * @param {string[][]} rows  Baris data (tanpa header) berisi kolom sesuai urutan
 *                           CONFIG.CSV_COLUMNS, semua bernilai string.
 * @param {string} fileName  Nama file, hanya untuk pesan ringkasan.
 */
function importRawTxn(rows, fileName) {
  if (!rows || !rows.length) throw new Error('CSV tidak berisi data.');

  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) {
    throw new Error('Sedang ada proses import lain. Coba lagi sebentar.');
  }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var target = ss.getSheetByName(CONFIG.TARGET_SHEET);
    if (!target) throw new Error('Sheet "' + CONFIG.TARGET_SHEET + '" tidak ditemukan.');

    assertTargetHeader_(target);
    var lookups = loadLookups_(ss);

    // Validasi + transformasi SEBELUM sheet dibersihkan.
    var result = transformRows_(rows, lookups);
    if (result.errors.length) {
      var shown = result.errors.slice(0, 15).join('\n');
      var more = result.errors.length > 15 ? '\n... dan ' + (result.errors.length - 15) + ' error lainnya.' : '';
      throw new Error('Import dibatalkan, Raw Txn tidak diubah.\n' + shown + more);
    }

    writeToTarget_(target, result.data);

    return {
      rows: result.data.length,
      fileName: fileName || '',
      unmappedProductTypes: result.unmappedProductTypes,
      unmappedClassNames: result.unmappedClassNames
    };
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* Transformasi (pure, tanpa akses Spreadsheet)                        */
/* ------------------------------------------------------------------ */

/**
 * @param {string[][]} rows  baris sesuai CONFIG.CSV_COLUMNS
 * @param {{productType:Object, grade:Object}} lookups  key = lowercase + trim
 * @return {{data:Array[], errors:string[], unmappedProductTypes:string[], unmappedClassNames:string[]}}
 */
function transformRows_(rows, lookups) {
  var src = {};
  CONFIG.CSV_COLUMNS.forEach(function (name, i) { src[name] = i; });
  var nSrc = CONFIG.CSV_COLUMNS.length;

  var data = [];
  var errors = [];
  var unmappedPT = {};
  var unmappedClass = {};

  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var line = r + 2; // nomor baris di file CSV (baris 1 = header)
    if (!row || row.length !== nSrc) {
      errors.push('Baris ' + line + ': jumlah kolom tidak sesuai.');
      continue;
    }
    var v = {};
    // Semua sel berisi "null" dikosongkan (Revenue kosong nanti diisi 0).
    CONFIG.CSV_COLUMNS.forEach(function (name) {
      var val = row[src[name]];
      if (isNullText_(val)) row[src[name]] = val = '';
      v[name] = val;
    });

    // Payment Date -> tanggal asli (serial number), format yyyy-mm-dd diatur di sheet.
    var serial = parseDateToSerial_(row[src['Payment Date']]);
    if (serial === null) {
      errors.push('Baris ' + line + ': Payment Date tidak valid "' + row[src['Payment Date']] + '".');
    } else {
      v['Payment Date'] = serial;
    }

    // Month -> nama bulan 3 huruf, diambil dari kolom Month itu sendiri.
    var mon = parseMonthAbbr_(row[src['Month']]);
    if (mon === null) {
      errors.push('Baris ' + line + ': Month tidak valid "' + row[src['Month']] + '".');
    } else {
      v['Month'] = mon;
    }

    // Payment Option -> FULL_PAYMENT / INSTALLMENT.
    v['Payment Option'] =
      String(row[src['Payment Option']]).trim().toUpperCase() === 'FULL_PAYMENT' ? 'FULL_PAYMENT' : 'INSTALLMENT';

    // New Product Type -> lookup; jika tidak ada, pertahankan nilai asli.
    var npt = String(row[src['New Product Type']]);
    var nptKey = lookupKey_(npt);
    if (has_(lookups.productType, nptKey)) {
      v['New Product Type'] = lookups.productType[nptKey];
    } else if (nptKey !== '') {
      unmappedPT[npt] = true;
    }

    // Grade -> lookup Class Name ke kolom "Kelas"; jika tidak ada, kosong.
    var cls = String(row[src['Class Name']]);
    var clsKey = lookupKey_(cls);
    if (has_(lookups.grade, clsKey)) {
      v['Grade'] = lookups.grade[clsKey];
    } else {
      v['Grade'] = '';
      if (clsKey !== '' && clsKey !== 'null') unmappedClass[cls] = true;
    }

    // Renewal Status -> boolean; "null"/kosong -> sel kosong.
    var rs = String(row[src['Renewal Status']]).trim().toLowerCase();
    v['Renewal Status'] = rs === 'true' ? true : rs === 'false' ? false : '';

    // Revenue -> angka; "null"/kosong -> 0.
    var rev = String(row[src['Revenue']]).trim();
    if (rev === '' || rev.toLowerCase() === 'null') {
      v['Revenue'] = 0;
    } else if (/^-?\d+(\.\d+)?$/.test(rev)) {
      v['Revenue'] = Number(rev);
    } else {
      errors.push('Baris ' + line + ': Revenue bukan angka "' + rev + '".');
    }

    data.push(CONFIG.TARGET_COLUMNS.map(function (name) { return v[name]; }));
  }

  return {
    data: data,
    errors: errors,
    unmappedProductTypes: Object.keys(unmappedPT).sort(),
    unmappedClassNames: Object.keys(unmappedClass).sort()
  };
}

function isNullText_(val) {
  return String(val).trim().toLowerCase() === 'null';
}

function lookupKey_(text) {
  return String(text).trim().toLowerCase();
}

function has_(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** "26 Nov 2026" / "25 Sept 2025" -> serial tanggal Google Sheets, atau null. */
function parseDateToSerial_(text) {
  var m = String(text).trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  var month = monthIndex_(m[2]);
  if (month < 0) return null;
  var day = Number(m[1]);
  var year = Number(m[3]);
  var utc = Date.UTC(year, month, day);
  var check = new Date(utc);
  if (check.getUTCDate() !== day || check.getUTCMonth() !== month) return null; // mis. 31 Feb
  // Serial Sheets = jumlah hari sejak 30 Des 1899. Bebas dari masalah timezone.
  return Math.round((utc - Date.UTC(1899, 11, 30)) / 86400000);
}

/** "1 Nov 2026" -> "Nov"; "1 Sept 2025" -> "Sep"; atau null. */
function parseMonthAbbr_(text) {
  var parts = String(text).trim().split(/\s+/);
  for (var i = 0; i < parts.length; i++) {
    var mi = monthIndex_(parts[i]);
    if (mi >= 0) return MONTHS[mi];
  }
  return null;
}

function monthIndex_(token) {
  var t = String(token).trim().toLowerCase();
  if (!/^[a-z]{3,}$/.test(t)) return -1;
  for (var i = 0; i < MONTHS.length; i++) {
    if (t.substring(0, 3) === MONTHS[i].toLowerCase()) return i;
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* Akses Spreadsheet                                                   */
/* ------------------------------------------------------------------ */

function normalizeHeader_(h) {
  return String(h).replace(/^﻿/, '').trim().toLowerCase();
}

/** Pastikan header baris 1 Raw Txn (kolom 1..18) sama dengan CONFIG.TARGET_COLUMNS. */
function assertTargetHeader_(sheet) {
  var cols = CONFIG.TARGET_COLUMNS;
  var n = cols.length;
  if (sheet.getMaxColumns() < n) {
    throw new Error('Sheet "' + CONFIG.TARGET_SHEET + '" kurang dari ' + n + ' kolom.');
  }
  var header = sheet.getRange(1, 1, 1, n).getDisplayValues()[0];
  var diffs = [];
  for (var i = 0; i < n; i++) {
    if (normalizeHeader_(header[i]) !== normalizeHeader_(cols[i])) {
      diffs.push('Kolom ' + (i + 1) + ': di sheet "' + header[i] + '", seharusnya "' + cols[i] + '"');
    }
  }
  if (diffs.length) {
    throw new Error('Header "' + CONFIG.TARGET_SHEET + '" tidak sesuai. Import dibatalkan.\n' + diffs.join('\n'));
  }
}

/** Baca semua tabel lookup dari sheet Validation (header di baris 1). */
function loadLookups_(ss) {
  var sheet = ss.getSheetByName(CONFIG.VALIDATION_SHEET);
  if (!sheet) throw new Error('Sheet "' + CONFIG.VALIDATION_SHEET + '" tidak ditemukan.');
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) throw new Error('Sheet "' + CONFIG.VALIDATION_SHEET + '" kosong.');

  var header = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(normalizeHeader_);
  var display = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, lastCol).getDisplayValues() : [];
  var raw = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];

  return {
    productType: buildLookup_(header, display, display, CONFIG.PRODUCT_TYPE_LOOKUP),
    // Grade diambil apa adanya (angka tetap angka, teks tetap teks).
    grade: buildLookup_(header, display, raw, CONFIG.GRADE_LOOKUP)
  };
}

function buildLookup_(header, keyValues, resultValues, spec) {
  var keyCol = header.indexOf(normalizeHeader_(spec.key));
  var valCol = header.indexOf(normalizeHeader_(spec.value));
  if (keyCol < 0 || valCol < 0) {
    throw new Error('Header "' + spec.key + '" dan/atau "' + spec.value +
      '" tidak ditemukan di baris 1 sheet "' + CONFIG.VALIDATION_SHEET + '".');
  }
  var lookup = {};
  for (var i = 0; i < keyValues.length; i++) {
    var k = lookupKey_(keyValues[i][keyCol]);
    if (!k || has_(lookup, k)) continue; // ambil kemunculan pertama
    lookup[k] = resultValues[i][valCol];
  }
  return lookup;
}

/** Kosongkan kolom 1..18 dari baris 2 ke bawah, lalu tulis data baru per batch. */
function writeToTarget_(sheet, data) {
  var cols = CONFIG.TARGET_COLUMNS;
  var n = cols.length;

  // 1. Bersihkan data lama (isi saja; kolom formula di kanan tidak disentuh).
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) sheet.getRange(2, 1, lastRow - 1, n).clearContent();

  // 2. Pastikan jumlah baris cukup.
  var needed = data.length + 1;
  if (sheet.getMaxRows() < needed) {
    sheet.insertRowsAfter(sheet.getMaxRows(), needed - sheet.getMaxRows());
  }

  // 3. Format kolom sebelum menulis: teks untuk kolom string (mencegah "25/26" jadi
  //    tanggal dan NPSN kehilangan angka 0 di depan), tanggal, dan angka.
  //    Renewal Status dipaksa ke format "General" (Automatic) agar TRUE/FALSE tersimpan
  //    sebagai boolean, bukan teks, walaupun kolom itu sebelumnya berformat teks.
  //    Grade (hasil lookup) memakai format yang sudah ada.
  var rows = data.length;
  var special = {
    'Payment Date': 'yyyy-mm-dd',
    'Revenue': '0',
    'Renewal Status': 'General',
    'Grade': null
  };
  for (var c = 0; c < n; c++) {
    var f = has_(special, cols[c]) ? special[cols[c]] : '@';
    if (f !== null) sheet.getRange(2, c + 1, rows, 1).setNumberFormat(f);
  }

  // 4. Tulis per batch.
  for (var start = 0; start < rows; start += CONFIG.WRITE_BATCH_ROWS) {
    var chunk = data.slice(start, start + CONFIG.WRITE_BATCH_ROWS);
    sheet.getRange(start + 2, 1, chunk.length, n).setValues(chunk);
    SpreadsheetApp.flush();
  }
}
