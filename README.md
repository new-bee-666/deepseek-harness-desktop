# DeepSeek Harness 桌面版（Windows 客户端）

因dsh本身不支持客户端版，故本项目制作一款 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Windows 桌面客户端：用 Electron 把 Harness 的 Web UI 包成本地应用，内置运行环境，
**安装即可用，无需单独安装 Node.js**。

> 底层 Harness 仍为官方 MIT 开源项目，本仓库在其基础上增加了桌面客户端封装（`apps/desktop/`）与打包流水线（`scripts/pack-desktop-client.mjs`）。

## 下载

到本仓库的 [Releases](https://github.com/new-bee-666/deepseek-harness-desktop/releases) 页面下载：

| 文件 | 说明 |
|---|---|
| `DeepSeek Harness Setup 0.3.0.exe` | 安装版：可选安装目录，创建桌面快捷方式 |
| `DeepSeek Harness 0.3.0.exe` | 便携版：免安装，双击即用 |

## 使用注意事项

### 首次启动

- 首次启动需要解压内置运行环境到 `%LOCALAPPDATA%\DeepSeek Harness\harness`，**首次启动约 30 秒**，之后启动约 4 秒，请耐心等待。
- 请勿在首次启动过程中重复双击 exe，避免多个实例互相冲突。

### 配置 API Key（必须）

- 客户端本身不带模型密钥，首次使用需要配置 DeepSeek API Key或者可支持模型的Key。
- 在设置页面填入，或手动编辑 `C:\Users\你的用户名\.dsh\.credentials.yaml`。

### 网络与端口

- Web UI 默认运行在 `http://127.0.0.1:3080`，仅供本机访问。
- 如 3080 端口被占用，客户端会自动复用或提示，请勿手动改端口导致连接失败。

### 更换背景

- 左下角有“更换背景”按钮，支持自定义本地图片作为对话背景。

### 卸载/清理

- 安装版：通过系统“添加或删除程序”卸载即可。
- 便携版：删除 exe 后，如需彻底清理，删除 `%LOCALAPPDATA%\DeepSeek Harness` 目录。

### 新添加个性化功能
- v0.1版本左下角有“更换背景”按钮，支持自定义本地图片作为对话背景。
- v0.2版本新增api余额显示功能（暂时只支持deepseek api余额显示）
- v0.3.0版本更新
  - 对话界面左下角余额按钮新增多款大模型余额查询接口：
  - 对话界面左下角新增 📂 打开文件夹 按钮。点击后用资源管理器打开当前工作区文件夹方便查看
  - 保活进程-关闭窗口后驻留系统托盘
  - 更换背景入口移入 **设置 → 通用设置**（“选择图片…”/“清除背景”），对话界面只保留余额显示。



## 从源码构建

环境要求：Windows、Node.js ≥ 22.19（建议 24.x）、pnpm。

```powershell
pnpm install --config.confirm-modules-purge=false
pnpm run build
node scripts/pack-desktop-client.mjs
```

产物输出到 `dist-exe\desktop\`。详细说明见 [apps/desktop](apps/desktop/package.json)。

## 开源说明

- 底层 Harness 源码版权归 DeepSeek AI，遵循 [MIT 许可证](LICENSE)。
- 桌面客户端封装部分同样以 MIT 许可证开源。
- 本仓库为个人定制版，与官方仓库无关，官方 CI 与质量门槛不适用于本仓库的桌面端改动。

## 反馈

问题或建议请在本仓库提交 Issue。
