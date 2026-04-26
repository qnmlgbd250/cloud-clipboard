# Cloud Clipboard ☁️

> 云剪贴板 - 多设备间实时同步文字和文件  
> Cross-device clipboard sync app with zero registration

<div align="center">

![Python](https://img.shields.io/badge/Python-3.x-3776AB?style=flat-square&logo=python)
![Flask](https://img.shields.io/badge/Flask-Web%20Framework-000000?style=flat-square&logo=flask)
![JavaScript](https://img.shields.io/badge/JavaScript-33.2%25-yellow?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)
![Realtime](https://img.shields.io/badge/Realtime-SSE-0A84FF?style=flat-square)

[📱 Live Demo](https://cloud-clipboard-one.vercel.app) • [🐛 Report Issues](../../issues) • [💡 Feature Request](../../discussions)

</div>

---

## ⚡ Quick Start

### 30 Seconds Setup

```bash
# Clone & setup
git clone https://github.com/qnmlgbd250/cloud-clipboard.git
cd cloud-clipboard
python -m venv .venv

# Activate virtual environment
source .venv/bin/activate  # macOS/Linux
# or
.venv\Scripts\activate     # Windows

# Install & run
pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:5000 in your browser.

### How It Works

1. **Open** → Browser auto-joins a room (see blue tag at top)
2. **Paste** → Content syncs in ~1 second (no button needed)
3. **Share** → Scan QR code or copy room link to other devices
4. **Sync** → Real-time updates across devices

---

## ✨ Features

- ✅ **Zero Registration** - No login, no app install
- ✅ **Real-time Sync** - Server-Sent Events (SSE) push
- ✅ **Cross-Device** - Phone, tablet, desktop
- ✅ **Privacy First** - Data stored locally, room ID = access control
- ✅ **Auto-Send** - No button click needed
- ✅ **Custom Rooms** - Random or custom room names
- ✅ **20-Day Retention** - Auto-cleanup policy

---

## 📋 Tech Stack

| Layer | Tech |
|-------|------|
| **Backend** | Python (31.4%) + Flask |
| **Frontend** | JavaScript (33.2%) + HTML (5.6%) + CSS (28.9%) |
| **Realtime** | Server-Sent Events (SSE) |
| **QR Code** | `qrcode` library |
| **Storage** | JSON files per room |
| **Deploy** | Docker, VPS, NAS |

---

## 📁 Project Structure

```
cloud-clipboard/
├── app.py                # Flask backend + all API routes
├── requirements.txt      # Python dependencies
├── static/
│   ├── app.js           # Frontend logic
│   └── style.css        # Styling
├── templates/
│   └── index.html       # UI template
├── data/                # Room data (auto-created)
├── docker-compose.yml   # Docker orchestration
├── Dockerfile           # Container config
└── gunicorn.conf.py     # Production server config
```

---

## 🚀 Deployment

### Docker (Recommended)

```bash
docker compose build
docker compose up -d
```

**1Panel Users:**
- Use repo's `docker-compose.yml`
- Only mount `./data:/app/data`
- Default PyPI mirror: Tsinghua (configurable in compose file)

### Manual Deploy

Works on:
- Personal VPS
- Home server / NAS
- Any Python 3.x environment

**Production tips:**
- Enable HTTPS (Let's Encrypt free cert)
- Use Nginx reverse proxy
- Keep 1 Gunicorn worker (in-memory SSE subscriptions)

---

## ❓ FAQ

| Q | A |
|---|---|
| **Login required?** | No. Open link → use immediately |
| **Data loss?** | 20-day auto-cleanup. Rooms idle 20+ days also purged |
| **Secure?** | Room ID is random/custom. Only those with link can access. Data on your server |
| **File support?** | Text only (v1). File support in roadmap |
| **Edit room name?** | Click `+` button to create new or customize |

---

## 📚 Use Cases

| Scenario | Example |
|----------|---------|
| Mobile → Desktop | Share article link from phone to PC |
| Desktop → Mobile | Send code snippet from computer to phone |
| Desktop → Desktop | Sync config/command between home & office PCs |
| Temp Share | Share link with friends for collaborative pasting |

---

## 🛣️ Roadmap

- [ ] File & image transfer
- [ ] Message burn-after-read
- [ ] Room password / single-use access
- [ ] Full-text history search
- [ ] SQLite / PostgreSQL backend
- [ ] Redis for multi-worker SSE

---

## 🤝 Contributing

1. **Fork** the repo
2. **Create branch** (`git checkout -b feature/amazing-feature`)
3. **Commit** (`git commit -m 'Add amazing feature'`)
4. **Push** (`git push origin feature/amazing-feature`)
5. **Open PR**

---

## 📝 License

MIT License - See [LICENSE](LICENSE) for details

---

## 🔗 Links

- 🌍 **Live Demo**: https://cloud-clipboard-one.vercel.app
- 👤 **Author**: [@qnmlgbd250](https://github.com/qnmlgbd250)
- 💬 **Discussions**: [GitHub Discussions](../../discussions)

---

<div align="center">

**⭐ If this project helps you, please consider starring!**

</div>
