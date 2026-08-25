<p align="center">
  <img src="docs/assets/qcpet-logo.png" width="180" alt="QCpet Logo" />
</p>

<h1 align="center">QCpet</h1>

QCpet 是一个面向 Windows 的开源 PSD 桌宠，支持 PSD 自动装配、桌面交互和可选的文字 AI 对话。  
它是基于petra修改的，进行了增删优化，以自用为主，所以表现可能不如petra好。原应用在：[https://github.com/Wumiu/Petra] 在这里感谢Wumiu大佬。

## 下载与运行

1. 从 GitHub Releases 下载 `QCpet-v0.2.0-windows-x64.zip`。
2. 将压缩包完整解压到一个普通文件夹。
3. 双击 `QCpet.exe`。

不要只移动 EXE；同目录下的 `models` 文件夹包含默认模型。QCpet 适用于 Windows 10/11 x64，并依赖 Microsoft Edge WebView2 Runtime（Windows 11 通常已自带）。

## 主要功能

- 导入分层 PSD，并自动识别脸、眼睛、眉毛、嘴和头发。
- 正式包内置 DeepSeek 与 Mika 两个 PSD 模型，可在「模型设置」中切换。
- 鼠标视线跟随、对话镜头视线、呼吸、眨眼及轻量头发物理。
- AI 对话可触发中性、害羞、嫌弃和惊讶状态；状态结束后会平滑恢复。
- 害羞状态包含渐进脸红和躲闪视线，嫌弃状态包含偏视、半睁眼、压眉与翻白眼。


右键桌宠可以打开设置菜单；左键点击桌宠可以开始对话。AI 对话默认关闭，不配置 API Key 也可以正常使用桌宠动画和 PSD 导入。  

## 怎么添加喜欢的模型？

- 1.叫ai生成一个正面q版立绘
- 2.把这个立绘丢到：[https://modelscope.cn/studios/ljsabc/See-Through] —— 一个自动拆层工具，免费的，建议拉满分辨率，种子随便 —— 得到psd文件
- 3.然后直接把这个psd文件丢到QCpet的模型设置里就好啦！


## AI 对话与情绪

对话设置支持 DeepSeek，以及自定义 OpenAI 兼容接口。API Key 由 Windows DPAPI 加密后保存在本机，不写入项目目录。

QCpet 已在内置系统提示中要求模型在回复开头返回以下标记之一，用户不需要修改自己的提示词：

```text
[emotion:neutral]
[emotion:shy]
[emotion:disgust]
[emotion:surprised]
```

该标记会在文字进入气泡前被移除，不会显示在对话记录中。如果模型没有按协议返回，QCpet 会使用保守的本地关键词规则兜底。

## RVC 语音路线

v0.2.0 目前只提供文字 AI 对话，尚未集成 RVC 声音模型。后续计划增加可选的本地语音链路：先把 AI 回复转换为基础语音，再交给用户自行导入的 RVC 模型进行音色转换，并提供开关、模型管理、缓存清理和失败时回退到文字的机制。

RVC 会作为可选功能，不影响纯文字聊天；项目不会内置第三方声线模型。使用者需要自行确认声音数据、模型和角色音色的授权，并避免未经同意模仿真实人物。

## 导入 PSD 的兼容性

QCpet 根据图层名称、层级、像素位置和透明区域自动推断部件。图层结构清晰、名称能表达“脸/眼白/瞳孔/眉/嘴/前发/后发”等含义时，装配效果最好。

通用情绪和点头动作只依赖自动识别出的基础面部部件，因此可用于后续导入模型；不同画师的切层方式差异很大，自动装配不能保证每个 PSD 都达到同样效果。公开版本不包含按文件名识别的私有模型特化，所有外部 PSD 都走相同的通用装配路径。

导入的模型保存在：

```text
%APPDATA%\com.wumiu.qcpet\models
```

## 从源码开发

需要 Node.js、Rust stable、Microsoft C++ Build Tools 和 WebView2 Runtime。

```powershell
npm ci
npm run tauri dev
```

检查前端和 Rust：

```powershell
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

生成正式便携包：

```powershell
npm run package:portable
```

产物会写入 `release/QCpet-v0.2.0-windows-x64.zip`。推送 `v*` 标签时，`.github/workflows/release.yml` 会在 GitHub Actions 中构建同样的 Windows 便携包并附加到 Release。

## 开源与资源说明

程序代码使用 [MIT License](LICENSE)。第三方名称、商标、图片与模型素材的权利仍归各自权利人所有，不因代码采用 MIT 许可证而自动获得重新授权。提交或重新分发模型素材前，请确认自己拥有相应许可。
