# Agent 视频工作流

运行桌面版后，通过已配置的 `canvas_studio` MCP 连接同一个项目与账号池。生成和下载在后台；首次登录或平台要求本人确认声明时，在项目中等待用户操作。

1. 调用 `studio_status`、`studio_accounts(list)`、`studio_projects(get)` 读取当前项目。选择脚本需要的国内豆包或 Dola，账号由工作台自动分配同平台的可用会话，不把国内任务切给海外。
2. 同一个镜头延续动作：调用 `studio_shot(kind:continue, sourceVideoAssetId:上一段素材ID)`。工具解码上一段最后一帧，回填图片、下一段生成节点和连线。保留人物、服装和场景提示词，补充下一段动作；先编辑、检查，随后才提交。
3. 切换分镜：使用 Codex 中可用的生图工具，以原角色图片和脚本为参考生成新画面。人物、服装和风格保持一致，除非脚本要求变化。用 `studio_shot(kind:new,imageFile:新图绝对路径)` 导入；也可先创建空节点，完成生图后使用 `studio_import_asset` 和 `studio_projects(save)` 按读取到的 expectedRevision 连接图片。新分镜不默认沿用上一镜头尾帧。
4. 需要明确目标尾帧时，把另一张生成/导入图片传为 `lastAssetId`。返回节点模式为 `first_last`；不指定尾图则为 `first`。素材与角色可在右侧面板核对。节点准备完成不代表平台支持原生首尾帧。
5. 调用 `studio_generate`，传项目、节点、完整提示词、输入角色、时长/比例/模型和稳定幂等键。相同调用重试沿用同一键；不同参数必须另建键。平台未识别原生角色或参数时保留等待原因，禁止偷偷改为参考图、缩短时长或重新生成。
6. 通过 `studio_tasks` 等待生成、下载和实际时长验证。`reconciling` 代表提交结果仍不确定，不能释放预算后重发。下载失败只使用 `studio_download(retry)`；查看实际视频后才能 `verify(clean:true)`。原视频不改写，平台元数据保留。
7. 完成所有片段后，用 `studio_merge(assetIds:脚本顺序,targetDuration:目标秒数)` 导出。硬切、保留原声，仅裁成片末尾，误差不超过一帧；素材不足则等待补充，不拉长或冻结画面。每段原片与成片均有独立素材/文件，可在画布打开文件位置。

视频保存后还需验收动作。调用 `studio_video_review(operation:comparison,assetId)` 获取提交时指定的首尾图和视频实际首尾帧；通过完整视频核对脚本动作。只能在实际观察视频或收到用户反馈后 `record(verdict:passed/rejected,reason)`，不能因为 done、5秒时长正确、输入为 first_last 或有两张图片就判定动作通过。拼接成片的时长不代表一次生成时长，也不能作为原生首尾帧证据。效果反馈不会释放已消耗的额度、改变水印验证或自动重生成。

## 本轮测试

`studio_validation(start)` 幂等返回当前测试 ID。真实任务都传 `validationRunId`，只允许 5 秒，国内/海外各最多两次；未知提交也占预算。`stop` 不释放未知任务。15 秒功能本轮不做真实生成。

## 15 秒与额度

国内账号使用 quotaMode:auto 时按平台反馈分配，新任务模型留空默认 Seedance 2.0 Fast；15秒不再写死每天一次。调用 studio_accounts(operation:quota,accountId)只读刷新套餐权益。百分比与未知余额不能换算成可生成条数；原任务若明确返回成本和余量，才记录对应模型/模式/时长的参考。未知提交先核实，不重新发送。Dola和manual模式仍按本地预算；不能以模型名称猜测独立额度。

选定国内 15 秒任务时，优先设置平台页面；页面无法设置时，兼容策略只修改当前任务对应的视频能力请求，不影响其他聊天。平台提议参数和下载实际时长都必须再次核对，平台拒绝时保留失败原因。

## 当前能力边界

已真实验证国内 Seedance 2.0 Mini 单图参考与 5 秒请求。当前页面未识别明确的原生首帧/首尾帧上传角色，因此不能声称原生首尾帧已验收。Dola Cookie 登录已通过实测，真实生成/下载仍需测试。生图由调用此 MCP 的 Codex Agent 执行，工作台接收生成图片；应用内没有另嵌独立大模型或 Codex API 密钥。

## Cookie 账号接入

用户提供本机 Cookie 文件并授权登录后，调用 studio_cookie_login(file:绝对路径,platform:doubao或dola,name:新账号名称,dailyLimit:本地预算,idempotencyKey:稳定键)。更新时传 accountId；不修改原预算或用量。只传文件路径，不读取或复述凭据原文。工具返回 checking 时查询 studio_accounts(list/probe)，ready 只代表页面登录检测通过，不证明真实生成、原生首尾或下载支持。此工具不发送消息、不生成视频，后续生成仍须按既定预算执行。
