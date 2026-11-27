/**
 * Import CSV transaksi ke sheet "Raw Txn".
 *
 * Alur:
 *   1. Menu "Import Transaksi" > "Upload CSV ke Raw Txn" membuka dialog (Upload.html).
 *   2. Browser membaca & mem-parse CSV, lalu hanya mengirim 18 kolom yang dibutuhkan
 *      (supaya payload kecil) ke fungsi server importRawTxn().
 *   3. Server memvalidasi & mentransformasi semua baris. Jika ada error, proses
 *      dibatalkan dan sheet "Raw Txn" TIDAK disentuh.
 *   4. Isi "Raw Txn" baris 2 ke bawah pada kolom 1..18 dikosongkan (kolom formula di
 *      kanannya tidak disentuh), lalu data baru ditulis per batch.
 */

var CONFIG = {
  TARGET_SHEET: 'Raw Txn',
  VALIDATION_SHEET: 'Validation',
  LOOKUP_KEY_HEADER: 'New Product Type',
  LOOKUP_VALUE_HEADER: 'New Product Type Edited',
  WRITE_BATCH_ROWS: 5000,
  // Urutan kolom = urutan header di baris 1 sheet "Raw Txn".
  COLUMNS: [
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
    'Region',
    'Payment Category',
    'Payment Option',
    'Academic Year',
    'Renewal Status',
    'school_npsn',
    'Revenue'
  ]
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
  html.columns = CONFIG.COLUMNS;
  SpreadsheetApp.getUi().showModalDialog(
    html.evaluate().setWidth(520).setHeight(360),
    'Upload CSV ke Raw Txn'
  );
}

/* ------------------------------------------------------------------ */
/* Entry point dipanggil dari Upload.html                              */
/* ------------------------------------------------------------------ */

/**
 * @param {string[][]} rows  Baris data (tanpa header), sudah berisi 18 kolom
 *                           sesuai urutan CONFIG.COLUMNS, semua bernilai string.
 * @param {string} fileName  Nama file, hanya untuk pesan ringkasan.
 * @return {{rows:number, fileName:string, unmappedProductTypes:string[]}}
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
    var lookup = loadProductTypeLookup_(ss);

    // Validasi + transformasi SEBELUM sheet dibersihkan.
    var result = transformRows_(rows, lookup);
    if (result.errors.length) {
      var shown = result.errors.slice(0, 15).join('\n');
      var more = result.errors.length > 15 ? '\n... dan ' + (result.errors.length - 15) + ' error lainnya.' : '';
      throw new Error('Import dibatalkan, Raw Txn tidak diubah.\n' + shown + more);
    }

    writeToTarget_(target, result.data);

    return {
      rows: result.data.length,
      fileName: fileName || '',
      unmappedProductTypes: result.unmapped
    };
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* Transformasi (pure, tanpa akses Spreadsheet)                        */
/* ------------------------------------------------------------------ */

/**
 * @param {string[][]} rows
 * @param {Object<string,string>} lookup  key = New Product Type (lowercase, trim)
 * @return {{data:Array[], errors:string[], unmapped:string[]}}
 */
function transformRows_(rows, lookup) {
  var idx = {};
  CONFIG.COLUMNS.forEach(function (name, i) { idx[name] = i; });
  var n = CONFIG.COLUMNS.length;

  var data = [];
  var errors = [];
  var unmapped = {};

  for (var r = 0; r < rows.length; r++) {
    var src = rows[r];
    var line = r + 2; // nomor baris di file CSV (baris 1 = header)
    if (!src || src.length !== n) {
      errors.push('Baris ' + line + ': jumlah kolom tidak sesuai.');
      continue;
    }
    var out = src.slice();

    // Payment Date -> tanggal asli (serial number), format yyyy-mm-dd diatur di sheet.
    var serial = parseDateToSerial_(src[idx['Payment Date']]);
    if (serial === null) {
      errors.push('Baris ' + line + ': Payment Date tidak valid "' + src[idx['Payment Date']] + '".');
    } else {
      out[idx['Payment Date']] = serial;
    }

    // Month -> nama bulan 3 huruf, diambil dari kolom Month itu sendiri.
    var mon = parseMonthAbbr_(src[idx['Month']]);
    if (mon === null) {
      errors.push('Baris ' + line + ': Month tidak valid "' + src[idx['Month']] + '".');
    } else {
      out[idx['Month']] = mon;
    }

    // Payment Option -> FULL_PAYMENT / INSTALLMENT.
    out[idx['Payment Option']] =
      String(src[idx['Payment Option']]).trim().toUpperCase() === 'FULL_PAYMENT' ? 'FULL_PAYMENT' : 'INSTALLMENT';

    // New Product Type -> lookup case-insensitive; jika tidak ada, pertahankan nilai asli.
    var npt = String(src[idx['New Product Type']]);
    var key = npt.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(lookup, key)) {
      out[idx['New Product Type']] = lookup[key];
    } else {
      unmapped[npt] = true;
    }

    // Renewal Status -> boolean; "null"/kosong -> sel kosong.
    var rs = String(src[idx['Renewal Status']]).trim().toLowerCase();
    out[idx['Renewal Status']] = rs === 'true' ? true : rs === 'false' ? false : '';

    // Revenue -> angka; "null"/kosong -> 0.
    var rev = String(src[idx['Revenue']]).trim();
    if (rev === '' || rev.toLowerCase() === 'null') {
      out[idx['Revenue']] = 0;
    } else if (/^-?\d+(\.\d+)?$/.test(rev)) {
      out[idx['Revenue']] = Number(rev);
    } else {
      errors.push('Baris ' + line + ': Revenue bukan angka "' + rev + '".');
    }

    data.push(out);
  }

  return { data: data, errors: errors, unmapped: Object.keys(unmapped).sort() };
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

/** Pastikan header baris 1 Raw Txn (kolom 1..18) sama dengan CONFIG.COLUMNS. */
function assertTargetHeader_(sheet) {
  var n = CONFIG.COLUMNS.length;
  if (sheet.getMaxColumns() < n) {
    throw new Error('Sheet "' + CONFIG.TARGET_SHEET + '" kurang dari ' + n + ' kolom.');
  }
  var header = sheet.getRange(1, 1, 1, n).getDisplayValues()[0];
  var diffs = [];
  for (var i = 0; i < n; i++) {
    if (normalizeHeader_(header[i]) !== normalizeHeader_(CONFIG.COLUMNS[i])) {
      diffs.push('Kolom ' + (i + 1) + ': di sheet "' + header[i] + '", seharusnya "' + CONFIG.COLUMNS[i] + '"');
    }
  }
  if (diffs.length) {
    throw new Error('Header "' + CONFIG.TARGET_SHEET + '" tidak sesuai. Import dibatalkan.\n' + diffs.join('\n'));
  }
}

/** Baca tabel lookup dari sheet Validation berdasarkan nama header di baris 1. */
function loadProductTypeLookup_(ss) {
  var sheet = ss.getSheetByName(CONFIG.VALIDATION_SHEET);
  if (!sheet) throw new Error('Sheet "' + CONFIG.VALIDATION_SHEET + '" tidak ditemukan.');
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) throw new Error('Sheet "' + CONFIG.VALIDATION_SHEET + '" kosong.');

  var header = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0].map(normalizeHeader_);
  var keyCol = header.indexOf(normalizeHeader_(CONFIG.LOOKUP_KEY_HEADER));
  var valCol = header.indexOf(normalizeHeader_(CONFIG.LOOKUP_VALUE_HEADER));
  if (keyCol < 0 || valCol < 0) {
    throw new Error('Header "' + CONFIG.LOOKUP_KEY_HEADER + '" dan/atau "' + CONFIG.LOOKUP_VALUE_HEADER +
      '" tidak ditemukan di baris 1 sheet "' + CONFIG.VALIDATION_SHEET + '".');
  }

  var lookup = {};
  if (lastRow < 2) return lookup;
  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getDisplayValues();
  for (var i = 0; i < values.length; i++) {
    var k = String(values[i][keyCol]).trim().toLowerCase();
    if (!k || Object.prototype.hasOwnProperty.call(lookup, k)) continue; // ambil kemunculan pertama
    lookup[k] = values[i][valCol];
  }
  return lookup;
}

/** Kosongkan kolom 1..18 dari baris 2 ke bawah, lalu tulis data baru per batch. */
function writeToTarget_(sheet, data) {
  var n = CONFIG.COLUMNS.length;
  var col = {};
  CONFIG.COLUMNS.forEach(function (name, i) { col[name] = i + 1; });

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
  //    Kolom Renewal Status tidak diberi format teks agar tetap boolean.
  var rows = data.length;
  var special = {};
  special[col['Payment Date']] = 'yyyy-mm-dd';
  special[col['Revenue']] = '0';
  special[col['Renewal Status']] = null; // biarkan format bawaan
  for (var c = 1; c <= n; c++) {
    var f = Object.prototype.hasOwnProperty.call(special, c) ? special[c] : '@';
    if (f !== null) sheet.getRange(2, c, rows, 1).setNumberFormat(f);
  }

  // 4. Tulis per batch.
  for (var start = 0; start < rows; start += CONFIG.WRITE_BATCH_ROWS) {
    var chunk = data.slice(start, start + CONFIG.WRITE_BATCH_ROWS);
    sheet.getRange(start + 2, 1, chunk.length, n).setValues(chunk);
    SpreadsheetApp.flush();
  }
}
