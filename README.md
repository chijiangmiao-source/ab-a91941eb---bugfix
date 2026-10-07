# 星载指令包服务（satcmd）

地面站与多版本维护终端之间往返编辑星载指令包的服务。核心保证：

- **未知字段不被静默抹去**：扩展子树（`extensions`）与可编辑核心字段（`core`）分离持久化，
  以其原始字节存储并原样回读；旧终端的局部修改永远触碰不到它。
- **并发修改不被伪装成安全合并**：陈旧修订只有在其实际改动的规范路径与既有修订不重叠
  （或同路径同值）时才可合并；同路径不同值、删除未知字段、同一请求标识替换载荷一律拒绝，
  且不改写任何既有版本。
- **可回放**：每次提交以 `requestId` 为幂等键记录裁决；页面重开或服务重启后，相同请求
  回放同一修订与规范摘要。

## 快速开始（Docker Compose）

```bash
# 默认宿主端口 8080；可用 HOST_PORT 覆盖
HOST_PORT=9000 docker compose up --build app

# 验收：契约测试 → 构建检查 → HTTP 冒烟，退出码即验收结果
docker compose up --build --exit-code-from verify verify
echo $?   # 0 = 验收通过，1 = 拒绝
```

健康检查：`GET /healthz` → `{"status":"ok",...}`（Compose healthcheck 已配置）。

本地无 Docker 时：

```bash
node app/server.js                 # PORT=8080 DATA_DIR=./data 可覆盖
APP_URL=http://127.0.0.1:8080 node verify/verify.js
```

## 网页

打开 `http://localhost:8080/`：

1. **创建指令包** — 填写核心字段与扩展字段（JSON）。
2. **终端提交局部修改** — 指定 `baseRevision`、终端声明的 `knownFields`、`changes.set/unset`。
3. **当前状态** — 当前修订、规范摘要（canonical + SHA-256）、响应中原始字节的扩展字段。
4. **裁决记录** — 每次提交的 applied / merged / rejected 及原因。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz` | 健康响应 |
| POST | `/api/packages` | 创建 `{core, extensions, id?}` → 201，rev 1 |
| GET | `/api/packages` | 列出包（id、revision、digest） |
| GET | `/api/packages/:id` | 当前修订、规范摘要、核心字段、原始字节扩展字段、全部裁决 |
| POST | `/api/packages/:id/edits` | 提交局部修改（见下） |

编辑包络：

```json
{
  "requestId": "终端生成的幂等键",
  "baseRevision": 3,
  "knownFields": ["core.command", "core.parameters.deltaV"],
  "changes": { "set": {"core.command": "ORBIT_LOWER"}, "unset": [] }
}
```

裁决规则：

- 改动路径必须被 `knownFields` 覆盖；`unset` 未声明路径 = 删除未知字段 → 422 拒绝。
- `baseRevision` 落后于当前修订时，仅当改动路径与期间修订的实际改动路径不重叠
  （或同路径结果相同）才合并；同路径不同值 → 409 `conflicting-paths`。
- 相同 `requestId` + 相同载荷 → 回放既有裁决（`replayed: true`）；
  相同 `requestId` + 不同载荷 → 409 `request-id-payload-mismatch`。
- 所有拒绝均不改写既有修订；扩展子树不可寻址，任何编辑都无法触及。

## 数据与持久化

每个包一个 JSON 文档存于 `DATA_DIR`（默认 `app/data`，容器内 `/data`，Compose 挂载卷
`app-data`），原子写入（tmp + rename）。`extensionsRaw` 保存创建请求中的原始字节；
规范摘要 = `sha256(canonical({core, extensions}))`，canonical 为键排序的无空白序列化，
与原始字节格式无关，因此重启/重放结果稳定。

## 验收（verify）

`verify/verify.js` 依次执行，任一阶段失败即以退出码 1 结束：

1. **包络契约测试** — `node --test app/tests/`（规范化、原始字节保留、合并/冲突、
   幂等回放、重启后状态重载）。
2. **构建检查** — 全部 JS 语法检查、清单与必需产物（含 Dockerfile、compose 文件）。
3. **HTTP 冒烟** — 健康接口、字段逐字节保留、删除未知字段拒绝、陈旧合并与冲突、
   请求标识回放/替换拒绝、新终端读回完整扩展内容。

## 结构

```
app/server.js            HTTP 服务（零依赖，node:http）
app/lib/envelope.js      规范化、规范路径、原始子树抽取、包络校验
app/lib/adjudicate.js    裁决引擎（合并/冲突/幂等）
app/lib/store.js         分离持久化（core + extensionsRaw）
app/public/index.html    审查网页
app/tests/contract.test.js  包络契约测试
verify/verify.js         验收编排（契约 → 构建 → 冒烟 → 退出码）
Dockerfile / docker-compose.yml
```
