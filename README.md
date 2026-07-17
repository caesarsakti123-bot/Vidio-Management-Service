# Open VMS — Video Management System multi-merek & multi-lokasi

Aplikasi open-source untuk menyatukan CCTV dari **berbagai merek** (Hikvision, Dahua, CP Plus, Uniview, Axis, dll) di **banyak lokasi fisik** — termasuk kamera di jaringan privat yang tidak punya IP publik — ke dalam satu portal, mirip secara konsep dengan Milestone XProtect / Genetec.

## Cara kerja (arsitektur singkat)

```
[Kamera merek A, B, C ... — IP publik]
        │  ONVIF / RTSP (protokol standar industri)
        ▼
[Server pusat]  <-- node "onvif" library + ffmpeg
        │
        ├── Live view    → ffmpeg convert RTSP → HLS → ditonton di browser (hls.js)
        ├── Recording    → ffmpeg segment RTSP → file .mp4 tersimpan lokal + auto-cleanup
        ├── Motion       → ffmpeg scene-change detection → trigger rekaman event-based
        ├── PTZ control  → ONVIF PTZ service (pan/tilt/zoom)
        └── Health check → cek konektivitas berkala → notifikasi email kalau offline
        ▼
[Dashboard web] — grid kamera, peta lokasi, kontrol PTZ, rekaman, log peristiwa

[Kamera di jaringan privat, tanpa IP publik]
        │  RTSP (lokal saja)
        ▼
[Relay agent — PC kecil di lokasi kamera]
        │  ffmpeg transcode → HLS, push keluar lewat HTTP (koneksi outbound, ramah firewall/NAT)
        ▼
[Server pusat] — menerima & menyajikan seolah-olah kamera lokal
```

Kuncinya: selama kamera Anda mendukung **ONVIF Profile S** (hampir semua CCTV modern mendukung ini) atau setidaknya RTSP, server ini bisa menariknya ke satu portal tanpa software bawaan vendor. Untuk kamera yang tidak punya IP publik, arsitektur **relay agent** menjembatani tanpa perlu buka port apa pun di jaringan kamera.

## Fitur yang sudah berjalan

**Kamera & streaming**
- Tambah kamera manual (IP, kredensial, RTSP path) atau **ONVIF probe** otomatis (ambil RTSP URL asli + deteksi dukungan PTZ tanpa perlu tahu format path tiap merek)
- Live view multi-kamera dalam grid dengan beberapa pilihan layout, pencarian & filter per lokasi
- Klik kamera untuk perbesar (focus view) dengan kontrol penuh
- Drag-and-drop untuk atur urutan kamera + pindah lokasi cepat lewat dropdown di tiap kotak kamera
- Auto-reconnect dengan exponential backoff kalau live stream terputus
- Kontrol PTZ (pan/tilt/zoom) untuk kamera yang mendukung
- Import banyak kamera sekaligus lewat CSV
- **Relay agent** (`relay-agent.js`) untuk kamera di jaringan privat/tanpa IP publik — jalan di PC lokal, push video keluar ke server pusat

**Rekaman & motion detection**
- Rekaman berkelanjutan per kamera (segmen 10 menit, fragmented MP4 tahan crash), dengan pembersihan otomatis sesuai retensi
- Deteksi HEVC otomatis + transcode ke H.264 supaya rekaman & live view bisa diputar langsung di browser
- Playback rekaman langsung di aplikasi + unduh
- Motion detection (ffmpeg scene-change) dengan sensitivitas yang bisa diatur per kamera, otomatis memicu rekaman event-based

**Lokasi & organisasi**
- Peta Lokasi (Leaflet) dengan pin per lokasi, auto-geolocation dari IP publik kamera saat lokasi baru dibuat
- Kamera baru otomatis dikelompokkan ke lokasi berdasarkan pola nama (site code), tidak perlu pilih manual tiap kali
- Alamat lokasi tampil langsung di tiap kotak kamera
- Rename lokasi inline, CRUD lokasi penuh

**User, keamanan & operasional**
- Login JWT, multi-user dengan role granular (**admin** / **operator** / **viewer**) — viewer tidak pernah menerima kredensial/token mentah lewat API
- Password kamera & RTSP URL **dienkripsi (AES-256-GCM)** di database, bukan plaintext
- Auto-restart proses lewat PM2 kalau server crash, termasuk auto-start saat PC dinyalakan ulang
- Notifikasi email (SMTP) otomatis saat kamera offline/kembali online, dengan health-check berkala yang independen dari live view
- Log peristiwa dengan filter kategori & indikator warna (kamera, stream, rekaman, motion, user, lokasi)
- Dashboard ringkasan (jumlah kamera, status, storage rekaman)
- **Halaman Pengaturan** (admin): branding (nama aplikasi & logo), SMTP notifikasi, retensi rekaman, performa live view (lebar/FPS/encoder), dan interval health-check — semua bisa diubah langsung dari aplikasi, berlaku seketika tanpa restart server dan tanpa edit `.env`

## Yang belum ada (jujur soal batasannya)

Ini masih terus dikembangkan, belum menyamai Milestone/Genetec di lingkungan enterprise besar. Yang belum tersedia:
- Video wall / layout kustom multi-monitor (drag-drop grid sudah ada untuk urutan kamera, tapi belum untuk susunan lintas monitor)
- PTZ preset tersimpan (baru kontrol manual pan/tilt/zoom)
- Failover / clustering server untuk skala sangat besar (ratusan-ribuan kamera)
- Analitik AI (deteksi wajah, line-crossing, object detection) — motion detection yang ada masih berbasis scene-change sederhana, bisa dikembangkan lebih jauh dengan integrasi model seperti YOLO/Frigate
- Discovery otomatis kamera di jaringan (WS-Discovery) — saat ini kamera ditambahkan manual + probe ONVIF per kamera
- Enkripsi stream end-to-end (HLS disajikan plain HTTP di jaringan lokal; pakai reverse proxy HTTPS kalau diakses dari luar)

## Instalasi

### Opsi 1: Docker (disarankan untuk deployment Linux)

```bash
cp .env.example .env
# edit .env — WAJIB ganti JWT_SECRET, ADMIN_PASSWORD, dan CAMERA_ENCRYPTION_KEY

docker compose up -d --build
```

Buka `http://localhost:4000`, login dengan `ADMIN_USERNAME` / `ADMIN_PASSWORD` dari `.env`.

### Opsi 2: Manual (Node.js + ffmpeg harus terinstal)

```bash
# Prasyarat: Node.js 18+, ffmpeg terinstal di sistem (apt install ffmpeg / brew install ffmpeg / winget install ffmpeg)

cp .env.example .env
# edit .env sesuai kebutuhan — generate CAMERA_ENCRYPTION_KEY dengan:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

npm install
npm start
```

Untuk produksi (auto-restart kalau crash, auto-start saat boot), jalankan lewat PM2:

```bash
npm install -g pm2
pm2 start src/index.js --name open-vms
pm2 save
# Windows: npm install -g pm2-windows-startup && pm2-startup install
# Linux/Mac: pm2 startup (ikuti instruksi yang muncul)
```

## Menambahkan kamera

1. Klik **"+ Tambah kamera"**.
2. Isi nama, merek (bebas, hanya label), dan alamat IP kamera. Kalau lokasi tidak dipilih manual, aplikasi otomatis mengelompokkan kamera ke lokasi berdasarkan pola namanya (dan menandai titik lokasinya di peta lewat IP publik, kalau ada).
3. Isi username/password kamera (biasanya admin + password yang di-set saat instalasi kamera). Ini tersimpan terenkripsi.
4. Simpan. Lalu klik **"Probe ONVIF"** pada tile kamera — sistem akan otomatis mengambil RTSP URL asli dan mendeteksi dukungan PTZ langsung dari kamera, tanpa Anda perlu tahu format path RTSP khusus merek tersebut.
5. Jika kamera tidak mendukung ONVIF (kamera lama), isi manual di field **"RTSP path manual"**, contoh: `/Streaming/Channels/101` (format umum Hikvision) atau `/cam/realmonitor?channel=1&subtype=0` (format umum Dahua).
6. **Kamera di jaringan privat / tanpa IP publik**: centang opsi relay saat menambah kamera, lalu jalankan `relay-agent.js` di PC yang senetwork dengan kamera tersebut — command siap-pakai (server, token, RTSP URL) tersedia lewat tombol "Info Agen" di kotak kamera.

## Catatan keamanan sebelum dipakai serius

- Ganti `JWT_SECRET`, `ADMIN_PASSWORD`, dan `CAMERA_ENCRYPTION_KEY` di `.env` — jangan pakai nilai default.
- Jalankan di belakang reverse proxy dengan HTTPS (nginx/Caddy) jika diakses dari luar jaringan lokal.
- Password kamera & RTSP URL dienkripsi (AES-256-GCM) sebelum disimpan di SQLite, memakai `CAMERA_ENCRYPTION_KEY`. Backup kunci ini terpisah dari database — kalau hilang, kredensial kamera yang tersimpan tidak bisa didekripsi lagi.
- Role `viewer` tidak pernah menerima RTSP URL/token mentah lewat API, hanya penanda "tersedia/tidak".
- Batasi akses jaringan ke port kamera (RTSP/ONVIF) hanya dari server VMS ini, bukan terbuka ke internet.
- Jalankan lewat PM2 (atau setara) di produksi supaya server otomatis pulih kalau terjadi crash.

## Struktur proyek

```
vms-app/
├── src/
│   ├── index.js              # entry point server + scheduler global
│   ├── db.js                 # skema SQLite + seed admin + helper dekripsi kamera
│   ├── crypto.js             # enkripsi/dekripsi AES-256-GCM untuk kredensial kamera
│   ├── auth.js                # login + JWT middleware + role guard
│   ├── users.js               # CRUD user & role
│   ├── cameras.js            # CRUD kamera, ONVIF probe, PTZ, start/stop stream & rekam
│   ├── locations.js          # CRUD lokasi (peta, auto-geolocation)
│   ├── streaming.js          # ffmpeg RTSP → HLS untuk live view
│   ├── recording.js          # ffmpeg rekaman tersegmentasi + retensi
│   ├── recordings_routes.js  # list, playback & download rekaman
│   ├── motion.js             # deteksi motion (scene-change) + trigger rekaman event
│   ├── relay.js               # endpoint penerima video dari relay agent
│   ├── healthcheck.js        # cek konektivitas kamera berkala
│   ├── notifications.js      # kirim email notifikasi kamera offline/online
│   ├── settings.js           # penyimpanan pengaturan dinamis (key/value, cached)
│   └── settings_routes.js    # API halaman Pengaturan (branding, SMTP, dll) + upload logo
├── public/                   # dashboard frontend (vanilla JS + hls.js + Leaflet)
├── relay-agent.js            # script standalone untuk PC di lokasi kamera privat
├── docker-compose.yml
├── Dockerfile
└── .env.example
```

## Roadmap pengembangan lanjutan

Urutan prioritas yang masuk akal untuk mendekati fitur Milestone/Genetec lebih jauh:
1. PTZ preset tersimpan per kamera
2. Layout video wall custom (susunan lintas monitor, simpan preset per user)
3. Discovery otomatis kamera di jaringan (ONVIF WS-Discovery)
4. Integrasi model deteksi objek (misalnya via Frigate atau custom YOLO service) untuk analitik AI yang lebih dari sekadar scene-change
5. Clustering multi-server untuk skala sangat besar (ratusan-ribuan kamera)
