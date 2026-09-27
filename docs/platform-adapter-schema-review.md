# P4 多平台报表适配与结构检查

## 数据边界
用户提供的 user_2026-09-26.xlsx 仅在本机读取表头和格式类型。未上传、未复制数据行到仓库、未用于 Staging 导入。单页结构为 A:AU 共47列；多列表头末尾空格属于明确源 Schema。测试使用合成 UID 和人工构造值。

## 源字段与口径
第二平台 money 默认除数100，仅 money 类型适用。币种、源时区使用所选 Platform，不能由文件名/数值推断。实际来源平台标识、时区和币种尚未由这张表单独确认，配置前必须核对，不能默认 FUN66。

|实际源字段|规范字段/扩展|规则与语义|
|---|---|---|
|玩家id （末尾空格）|uid|沿用P3 canonicalUid，不除100|
|注册时间、最后登陆时间|registered_at、login_time|YYYY-MM-DD HH:mm:ss，按Platform时区解释|
|当日充值、当日赠送、当日提现、当日充提差|deposit、gift、withdrawal、source_net|来源报告的当日金额，÷100，不覆盖source_net|
|当日充值次数|deposit_count|整数计数，不缩放|
|玩家首充日期|first_deposit_date|1900-01-01 00:00:00仅此字段→NULL；其余按明确格式|
|玩家首充金額|first_deposit|÷100；与日期交叉校验|
|渠道名称、总代名称|channel、agent|来源标签，不构造归因结论|
|实时账号余额|extension.account_balance|money ÷100，时点/可用余额口径待确认|
|当日投注、当日返奖、当日盈亏|extension.reported_daily_bet/payout/profit|money ÷100；有效投注/总投注、正负视角待确认，不映射核心bet/payout/game_profit|
|当日体验金投注、当日体验金返奖、当日体验金盈亏|extension.trial_daily_*|money ÷100，体验金边界待确认|
|历史充值、历史赠送、历史提现、历史充提差|extension.historical_*|money ÷100，历史累计截止范围待确认，不当作当日值|
|历史总投注、历史总返奖、历史盈亏|extension.historical_bet/payout/profit|money ÷100，口径待确认|
|历史体验金投注、历史体验金返奖、历史体验金盈亏|extension.historical_trial_*|money ÷100，口径待确认|
|最近存款金額(最后转入金额)|extension.last_transfer_amount|money ÷100；“存款”与“转入”的区别待确认，不映射当日充值|
|最近存款時間、最近下注時間|extension.last_deposit_at/last_bet_at|1900值保留raw证据，规范值NULL并发unconfirmed_sentinel_semantics，不推断未存款/未下注|
|近两个月充值天数、近两个月提款天数|extension.recent_*_days|整数不缩放，窗口由来源定义|
|平台、游戏id 、日期 、上级id、用户类型、状态、渠道号、总代号|仅受控raw|身份/代码/源口径未批准映射；不得除100，日期不用于business_date|
|注册IP、用户邮箱、最后登陆ip、最后登录设备、最后登录设备码UUID|仅受控raw|敏感来源证据，普通列表与Mini不输出，不纳入Canonical核心|

实际格式：金额、ID、计数多为Excel数值；时间为无offset文本；部分列有空值。不能通过数值类型推断money。原表超过当前每批1000行上限，本轮不放宽容量，也不导入真实文件。正式大报表接入需单独设计范围/分批与资源预算，不能把部分文件标成全量。

## 版本与追溯
Source → server-owned Adapter → immutable Mapping snapshot → canonical normalized values → Revision。规则在 src/platform-adapters.ts 集中声明，客户端不能提交任意执行代码、除数或哨兵。新版本只新增，不修改旧定义。

Batch.mapping 保存 adapterId/mappingVersion/schemaIdentifier/platformId/sourceType/timezone/currency、完整定义、定义摘要、实际列fingerprint、fieldAvailability；created_at使用Batch自身时间，status=active表示该规则版本被用于此批次，不代表批次已Activate。Revision通过batch_id关联不可变snapshot，normalized包含adapter版本及定义摘要；raw原值保持不变。旧009批次的扁平mapping按legacy explicit-canonical v1解释，不回写历史。

Canonical extension是配置声明的typed对象，仅包含白名单字段、类型、规范值、源口径及unconfirmed标识；未知源字段直接unsupported_schema。核心FK、状态、唯一性仍在关系模型。P5读取extension前必须明确批准语义，不能依赖中文列名或自行解释unconfirmed。

010仅为批次增加mapping_digest并扩展文件去重唯一键。旧记录default为legacy全0标记，保留旧metadata去重行为。不同版本的同一文件允许新批次，但仍要通过差异预检、显式确认、同日Revision及scope保护。Runtime现有INSERT/SELECT覆盖新增列，不增加角色权限。001–009不改。

## 首充与日期
has_first_deposit为派生结果，不独立编辑：哨兵+明确0→false；正常日期+正金额→true；哨兵+正金额、正常日期+NULL/0→null+warning。缺失全部保持未知，不推断权益。
日期格式由mapping指定。提供ymd/dmy/mdy/local/ISO/Excel1900 serial解析器；不猜locale，DST重叠/不存在时间拒绝。当前第二平台实际使用local文本；Excel日期单元格未获该mapping批准，不静默转换。新source支持Excel serial必须显式声明format。

## 三种验证对象
1. 现有FUN66/显式Canonical v1：保留既有列映射、金额单位和幂等行为。
2. player-report-minor-units v1：第二真实报表列结构＋完全合成行，money ÷100。
3. synthetic-mx v1：不同英文列名、DD/MM/YYYY，缺提现/派彩→NULL；只是测试Schema，不创建真实MX平台。

## 边界
不创建权益、积分、奖励、游戏次数、兑换或Telegram用户。不把真实文件用于Staging。P4此前合成事实保持不动，010和新部署需独立验收后才能封版。结构/自动化通过不等于真实第二平台数据业务口径已确认。
