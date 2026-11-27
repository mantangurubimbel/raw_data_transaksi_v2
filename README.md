# Import CSV ke "Raw Txn" (Google Apps Script)

Menambahkan menu **Import Transaksi → Upload CSV ke Raw Txn** di Google Sheet.

## Pemasangan
1. Buka spreadsheet → **Extensions → Apps Script**.
2. Salin isi `apps-script/Code.gs` ke file `Code.gs`.
3. Buat file HTML baru bernama **`Upload`** (tanpa `.html`), salin isi `apps-script/Upload.html`.
4. Simpan, lalu muat ulang spreadsheet. Menu **Import Transaksi** akan muncul.
5. Saat pertama kali dipakai, setujui izin (authorize) script.

## Yang dilakukan script
- Mengambil 17 kolom dari CSV berdasarkan **nama header** (case-insensitive), kolom lain (termasuk `Region`) diabaikan.
- Menulis 18 kolom ke `Raw Txn` (A–R): 17 kolom di atas + `Grade` di kolom paling kanan.
- `Payment Date` → tanggal asli, format `yyyy-mm-dd`.
- `Month` → nama bulan 3 huruf dari kolom Month CSV (`1 Sept 2025` → `Sep`).
- `Payment Option` → `FULL_PAYMENT`, selain itu `INSTALLMENT`.
- `New Product Type` → lookup case-insensitive ke sheet **Validation**
  (header baris 1: `New Product Type` → `New Product Type Edited`). Jika tidak ditemukan, nilai asli dipertahankan
  dan daftarnya ditampilkan setelah upload.
- `Grade` → lookup `Class Name` ke sheet **Validation** (header `Kelas` → `Grade`), case-insensitive.
  Jika tidak ditemukan, Grade dikosongkan dan daftar Class Name tersebut ditampilkan setelah upload.
- Semua sel berisi `null` dikosongkan (khusus `Revenue` diisi 0).
- `Renewal Status` → boolean TRUE/FALSE (bukan teks; kolom diformat Automatic). `null` → sel kosong.
- `Revenue` → angka, `null` → 0.
- `school_npsn` dan kolom teks lain ditulis sebagai teks (angka 0 di depan tidak hilang).
- Urutan baris mengikuti CSV (tidak diurutkan ulang).

## Keamanan data
- Header baris 1 `Raw Txn` (kolom A–R) dicek harus sama dengan 18 kolom target (lihat `CONFIG.TARGET_COLUMNS`).
- Semua validasi dilakukan **sebelum** `Raw Txn` dibersihkan; jika ada error, sheet tidak diubah.
- Yang dibersihkan hanya kolom A–R baris 2 ke bawah. Kolom formula di sebelah kanan tidak disentuh.
- Konfigurasi (nama sheet, daftar kolom) ada di objek `CONFIG` di awal `Code.gs`.

---

# Web App: Revenue per Branch

File: `apps-script/WebApp.gs` + `apps-script/Dashboard.html` (di project Apps Script yang sama).

- Sumber data: sheet **`[Use] Raw Txn`**, kolom dicari berdasarkan nama header baris 1
  (`Payment Date`, `Cluster`, `Revenue`, `Academic Year`, `New Product Type`).
- Agregasi dilakukan di server; browser hanya menerima ringkasan per branch.
- Filter: Academic Year, rentang Payment Date, New Product Type.
- Tren revenue bulanan (berdasarkan bulan Payment Date).
- **Perbandingan YoY**: jika Academic Year dipilih (mis. `26/27`) dan Academic Year sebelumnya (`25/26`) ada di data,
  capaian dibandingkan pada periode yang sama digeser 1 tahun. Tanggal akhir = filter *Sampai tanggal*, atau
  Payment Date terakhir di tabel bila kosong (mis. s/d 26 Nov 2026 vs s/d 26 Nov 2025). Filter *Dari tanggal* dan
  *New Product Type* berlaku untuk kedua periode.

## Deploy
1. Di editor Apps Script tambahkan file script **`WebApp`** (isi dari `WebApp.gs`) dan file HTML **`Dashboard`** (isi dari `Dashboard.html`).
2. **Deploy → New deployment → Select type: Web app**.
   - *Execute as*: **Me**
   - *Who has access*: **Anyone within ruangguru** (atau sesuai kebutuhan)
3. Salin URL `/exec` yang muncul. Setelah mengubah kode, gunakan **Manage deployments → Edit → New version** agar URL tetap sama.
