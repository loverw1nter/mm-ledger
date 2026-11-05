<p align="center"><img src="public/icon-180.png" width="88" alt="小账本"></p>

<h1 align="center">小账本</h1>

<p align="center">一个跑在 Cloudflare Workers + D1 上的单人记账 PWA。</p>

手机和电脑打开同一个网址，就能共用一份账本。没有广告、订阅和导出限制，数据放在自己的 Cloudflare 账号里。底部还内置了一个「饭桌」食物计划本。

## 功能

- 支出 / 收入记账，支持一级分类和一层子类
- 子类胶囊右侧「＋」快捷新建子类
- 明细支持跨月份搜索分类、子类和备注
- 多选账单，批量删除或批量移动到其他分类
- 月度统计、分类占比、近 7 天花销
- 攒钱目标、存入 / 取出记录
- 饭桌周计划、食材和菜单管理
- CSV 账单导入 / 导出，攒钱记录单独导出
- PWA，可添加到 iPhone / 安卓主屏幕
- 手机、平板和电脑自动同步

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

复制 `.dev.vars.example` 为 `.dev.vars`，把里面的密码和会话密钥改成自己的：

```text
APP_PASSWORD=你的登录密码
SESSION_SECRET=一段长随机字符串
```

初始化本地数据库并启动：

```bash
npx wrangler d1 migrations apply mm-ledger --local
npm run dev
```

打开 http://localhost:8787 ，用刚才设置的 `APP_PASSWORD` 登录。

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

4. 设置线上密码和会话密钥：

```bash
npx wrangler secret put APP_PASSWORD
npx wrangler secret put SESSION_SECRET
```

`SESSION_SECRET` 可以用一段长随机字符。修改它会让已登录的设备重新登录。

5. 发布：

```bash
npm run deploy
```

会得到一个 `https://mm-ledger.<你的子域>.workers.dev` 地址。

## 多设备同步

同步靠 Cloudflare D1，不靠 GitHub。

手机和电脑都打开同一个线上网址，用同一个 `APP_PASSWORD` 登录，看到的就是同一份数据；任意一台记账，另一台刷新后就能看到。GitHub 仓库只存代码，不存账本数据。

iPhone 用 Safari、安卓用 Chrome，登录后在分享菜单里选「添加到主屏幕」，用起来和 App 一样。

## 导入旧账单

「我的 → 导入 CSV」，选择从旧记账软件导出的 CSV。

表头需要包含「日期」和「金额」；「收支」「分类」「子类」「图标」「备注」「账单ID」可选（「编号」也认作账单ID）。子类不存在时会自动建到对应分类下面。重复导入不会产生重复数据（按账单ID去重）。

## 数据与备份

「我的 → 导出 CSV」导出账单；「导出攒钱 CSV」单独导出攒钱记录。随时下载，没有限制。

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

- `bills`：账单
- `categories`：一级分类和子类，`parent_id` 为空表示一级分类
- `savings`：攒钱记录，正数是存入、负数是取出
- `app_settings`：键值配置，目前存攒钱目标
- `fanzhuo_state`：饭桌数据快照，登录后自动同步

## 说明

分类体系参考了「喵喵记账」，方便从旧账本迁移。项目按单人使用设计，没有多用户和权限系统。
