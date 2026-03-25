# Cloud Clipboard

一个轻量、直接、可自部署的跨设备云剪贴板。

它解决的是一个很具体但高频的问题: 电脑上复制了一段文本，想立刻发到手机；或者手机上记下了一段内容，想马上在另一台设备继续使用。`Cloud Clipboard` 用“房间”作为最小协作单元，不需要登录、不需要安装客户端，打开链接即可开始同步。

## Why This Project

很多“跨设备剪贴板”产品都很重:

- 依赖账号体系
- 强绑定平台生态
- 部署复杂
- 数据流转不透明

`Cloud Clipboard` 选择了更朴素的一条路线:

- 房间即链接，进入就能用
- 服务端体积小，依赖少
- 支持自部署，数据可控
- 面向移动端和桌面端的快速输入场景优化

如果你想要的是一个适合自己托管、可以继续二开、也足够适合日常分享文本的小工具，这个项目就是为这个目标设计的。

## Features

- 实时同步: 基于 Server-Sent Events，房间内容更新后其他设备几乎立刻可见
- 零登录房间模式: 自动生成房间，也支持手动输入自定义房间号
- 二维码分享: 打开页面即可生成当前房间二维码，适合手机和电脑之间快速接力
- 自动发送: 停止输入约 1 秒后自动提交，降低多端切换时的操作成本
- 手动管理内容: 支持单条复制、单条删除、整房清空
- 过期清理机制: 内容和房间都有 TTL，空房间也会自动回收
- 基础防滥用: 写入频率限制、单房间条目上限、总房间数上限
- 文件存储简单: 每个房间落为一个 JSON 文件，方便调试、迁移和二次开发
- 移动端友好: 针对紧凑预览、键盘输入和页面重新聚焦做了细节处理

## Stack

- Backend: Python + Flask
- Frontend: Vanilla JavaScript + HTML + CSS
- Realtime: Server-Sent Events
- QR Code: `qrcode`
- Storage: local JSON files

## Project Structure

```text
.
├─ app.py
├─ requirements.txt
├─ data/
├─ static/
│  ├─ app.js
│  └─ style.css
└─ templates/
   └─ index.html
```

## Quick Start

### 1. Clone

```bash
git clone git@github.com:qnmlgbd250/cloud-clipboard.git
cd cloud-clipboard
```

### 2. Create a virtual environment

```bash
python -m venv .venv
```

Windows:

```bash
.venv\Scripts\activate
```

macOS / Linux:

```bash
source .venv/bin/activate
```

### 3. Install dependencies

```bash
pip install -r requirements.txt
```

### 4. Run the server

```bash
python app.py
```

默认启动地址:

```text
http://127.0.0.1:5000
```

打开后系统会自动跳转到一个随机房间。把这个链接发到另一台设备，或直接扫码，就可以开始共享内容。

## How It Works

### 房间模型

- 每个房间都有独立 ID
- 每条内容都带有创建时间和唯一 ID
- 房间状态持久化在 `data/<room>.json`

### 实时同步

- 前端优先使用 SSE 长连接监听更新
- 如果浏览器不支持 SSE，则退回轮询

### 生命周期管理

- 内容有保留时长限制
- 活跃房间有保留时长限制
- 空房间会更快回收
- 后端会定期清理过期数据

### 安全和稳定性

- 对房间名做了白名单过滤
- 对写操作做了基于 IP 的频率限制
- 对房间总量和单房间条目数做了上限控制
- 对响应头设置 `no-store`，尽量避免缓存带来的旧数据问题

## Use Cases

- 手机和电脑之间快速传文本
- 两台电脑之间临时接力命令、代码片段、链接
- 团队内部共享一个短期文本投递房间
- 自建一个比“聊天发给自己”更轻、更直接的中转工具

## Deployment Notes

这个项目适合部署在:

- 个人 VPS
- 家庭服务器
- Docker 容器环境
- 反向代理后的 Flask 服务

如果放到公网，建议至少补充这些能力:

- 反向代理和 HTTPS
- 更严格的限流策略
- 访问日志和错误监控
- 可选的鉴权或房间访问口令
- 将本地 JSON 存储替换为 Redis / SQLite / PostgreSQL

## Roadmap Ideas

- 支持图片、文件和富文本
- 支持“阅后即焚”消息
- 支持房间密码或一次性访问令牌
- 支持分享历史搜索
- 支持容器化部署和环境变量配置
- 支持数据库后端

## Contribution

欢迎基于这个项目继续打磨。

你可以从这些方向开始:

- 改进 UI / UX
- 增强房间安全策略
- 优化移动端交互
- 增加部署方案
- 扩展更多消息类型

提 Issue、开 PR、做 Fork 二开都很合适。

## Development Notes

- 主入口: [app.py](/C:/pydome/day-2026-03-23/app.py)
- 前端逻辑: [static/app.js](/C:/pydome/day-2026-03-23/static/app.js)
- 页面模板: [templates/index.html](/C:/pydome/day-2026-03-23/templates/index.html)

如果你在找一个适合作为“小而完整的 Flask 项目”来阅读、二开或部署的示例，这个仓库也很合适: 后端边界清晰，前端不依赖框架，功能却已经覆盖了一个真实可用的跨设备文本同步场景。
