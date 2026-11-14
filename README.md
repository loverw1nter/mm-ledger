<p align="center"><img src="public/icon-180.png" width="88" alt="小账本"></p>

<h1 align="center">小账本</h1>

<p align="center">一个跑在 Cloudflare Workers + D1 上的多账号记账 PWA。</p>

手机和电脑打开同一个网址，登录同一个账号就能共用一份账本。每个账号的账单、分类、统计设置和饭桌数据完全隔离。没有广告、订阅和导出限制，数据放在自己的 Cloudflare 账号里。底部还内置了一个「饭桌」食物计划本。

## 功能

- 多账号，各自独立的账单、分类、统计设置和饭桌数据
- 支出 / 收入记账，支持一级分类和一层子类
- 子类胶囊右侧「＋」快捷新建子类
- 明细支持跨月份搜索分类、子类和备注
- 多选账单，批量删除或批量移动到其他分类
- 月度统计、分类占比、近 7 天花销、可展开的日均计算
- 预计收款：用忽略大额后的日均估算本月预计剩下多少钱
- 饭桌周计划、食材和菜单管理
- CSV 账单导入 / 导出
- PWA，可添加到 iPhone / 安卓主屏幕
- 手机、平板和电脑自动同步
- 管理员可在「我的 → 账号管理」查看和添加账号

界面使用浅灰蓝新拟态风格：悬浮卡片、柔和阴影、毛玻璃和冷色阴影。

## 技术栈

- Cloudflare Workers + Static Assets
- Cloudflare D1
- Hono
- 原生 JavaScript / CSS，无前端构建步骤

## 本地运行

需要 Node.js 18 以上。

```bash
npm install
```

复制 `.dev.vars.example` 为 `.dev.vars`，把里面的初始密码和会话密钥改成自己的：

```text
APP_PASSWORD=main 账号的初始密码
SESSION_SECRET=一段长随机字符串
```

初始化本地数据库并启动：

```bash
npx wrangler d1 migrations apply mm-ledger --local
npm run dev
```

打开 http://localhost:8787 ，账号填 `main`，密码填刚才设置的 `APP_PASSWORD`。第一次登录成功后，密码会自动转成加密保存，之后照常使用。

## 部署到 Cloudflare

1. 登录 Cloudflare：

```bash
npx wrangler login
```

2. 创建 D1 数据库：

```bash
npx wrangler d1 create mm-ledger
```

把输出里的 `database_id` 填进 `wrangler.jsonc`。

3. 建表：

```bash
npm run db:remote
```

4. 设置 `main` 账号的初始密码和会话密钥：

```bash
npx wrangler secret put APP_PASSWORD
npx wrangler secret put SESSION_SECRET
```

`APP_PASSWORD` 只在 `main` 第一次登录时使用，登录后密码会以加密形式写进数据库。`SESSION_SECRET` 可以用一段长随机字符，修改它会让已登录的设备重新登录。

5. 发布：

```bash
npm run deploy
```

会得到一个 `https://mm-ledger.<你的子域>.workers.dev` 地址。

## 多账号

第一个账号是管理员 `main`。登录后进入「我的 → 账号管理」，可以查看所有账号和账单数量，也可以添加新账号。新账号会自动获得一套默认分类，账本从零开始。

目前添加账号只能由管理员操作，页面里还没有自助改密码和删账号的功能。忘记密码时，可以在数据库里清空该账号的 `password_hash`，再重新处理。

## 多设备同步

同步靠 Cloudflare D1，不靠 GitHub。

手机和电脑都打开同一个线上网址，用同一个账号和密码登录，看到的就是同一份数据；任意一台记账，另一台刷新后就能看到。不同账号之间互相看不到对方的账单。GitHub 仓库只存代码，不存账本数据。

iPhone 用 Safari、安卓用 Chrome，登录后在分享菜单里选「添加到主屏幕」，用起来和 App 一样。

## 导入旧账单

「我的 → 导入 CSV」，选择从旧记账软件导出的 CSV。

表头需要包含「日期」和「金额」；「收支」「分类」「子类」「图标」「备注」「账单ID」可选（「编号」也认作账单ID）。子类不存在时会自动建到对应分类下面。重复导入不会产生重复数据（按账单ID去重）。

## 数据与备份

「我的 → 导出 CSV」导出账单，随时下载，没有限制。

D1 数据在 Cloudflare 上，建议定期导出 CSV 存一份。本地 `.dev.vars`、`.wrangler` 和数据库文件都已加入 `.gitignore`，不会提交到 Git。

## 项目结构

```text
public/            前端页面、样式、图标和饭桌
src/index.ts       Worker API、登录、D1 查询
migrations/        D1 表结构
proxy/_worker.js   可选的 pages.dev 反向入口
wrangler.jsonc     Worker 与 D1 配置
```

## 国内访问

`workers.dev` 在国内可能被 DNS 污染。`proxy/_worker.js` 是给 Cloudflare Pages 用的可选反向入口：通过 service binding 直连 Worker，不经过 `workers.dev`。

不需要这个入口时，直接使用 Worker 的 `workers.dev` 地址或绑定自己的域名即可。

## 数据表

- `users`：账号、角色和加密后的密码
- `bills`：账单
- `categories`：一级分类和子类，`parent_id` 为空表示一级分类，按账号隔离
- `app_settings`：按账号保存的键值配置，例如预计收款金额
- `fanzhuo_state`：按账号保存的饭桌数据快照，登录后自动同步

## 说明

分类体系参考了「喵喵记账」，方便从旧账本迁移。账号由管理员统一创建，适合自己和家人朋友各用一份互不干扰的账本。
