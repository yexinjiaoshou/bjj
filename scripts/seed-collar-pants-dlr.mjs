#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import ELK from "elkjs/lib/elk.bundled.js";

const LIBRARY_ID = "ec065329-b440-4616-975e-cc3639f18ef2";
const APP_DATA_ROOT = resolve(
  process.env.ROLLMAP_APP_DATA_ROOT ??
    "/Users/ypf/Library/Application Support/com.rollmap.app",
);
const DATABASE_PATH = resolve(
  APP_DATA_ROOT,
  `rollmap-library-${LIBRARY_ID}.db`,
);
const APPLY = process.argv.includes("--apply");

function position(
  id,
  name,
  description,
  category,
  role,
  aliases = [],
  tags = [],
) {
  return {
    id,
    name,
    aliases,
    description,
    category,
    role,
    tags: ["领裤把德拉", ...tags],
    x: 0,
    y: 0,
  };
}

function technique(
  id,
  sourcePositionId,
  targetPositionId,
  name,
  description,
  difficulty = "intermediate",
  tags = [],
) {
  return {
    id,
    sourcePositionId,
    targetPositionId,
    name,
    description,
    giMode: "gi",
    difficulty,
    tags: ["领裤把德拉", ...tags],
  };
}

const positions = [
  position(
    "dlr-standing-entry",
    "站立开放位·领裤把入口",
    "双方站立或下位准备坐入。先建立安全距离与领口控制，再选择坐姿进入；不要在膝盖内扣、头部失去保护时直接坐下。",
    "standing",
    "neutral",
    ["Standing collar-pants entry"],
    ["入口", "站立"],
  ),
  position(
    "dlr-seated-entry",
    "坐姿领裤把",
    "下位坐姿，以领把控制上身，以近侧裤脚或膝侧裤布控制腿线。头高于髋，肘靠近肋骨，准备让外侧脚进入德拉勾。",
    "guard",
    "bottom",
    ["Seated collar-pants guard"],
    ["入口", "坐姿", "握把"],
  ),
  position(
    "dlr-open-reset",
    "开放防守重置位",
    "原有勾或握把被拆后，以双脚框架、膝肘连接和安全距离重新组织。优先让髋部面向对手，再恢复领把、裤把或替代防守。",
    "guard",
    "bottom",
    ["Open guard reset"],
    ["恢复", "框架"],
  ),
  position(
    "dlr-base",
    "领裤把德拉·基础位",
    "领把控制对手姿势，裤把控制近侧腿线；外侧脚绕入德拉勾，自由脚管理远侧髋或腿。核心目标是同时控制肩线与膝线，而不是只依赖勾脚悬挂。",
    "guard",
    "bottom",
    ["Collar and pants De La Riva", "Collar-pants DLR"],
    ["核心", "德拉勾", "握把"],
  ),
  position(
    "dlr-shallow",
    "领裤把德拉·浅勾",
    "德拉脚只在小腿外侧形成较浅的挂钩，适合快速恢复与保持距离。必须配合裤把和自由脚框架，避免对手轻易拔腿或腿拖。",
    "guard",
    "bottom",
    ["Shallow DLR hook"],
    ["浅勾", "恢复"],
  ),
  position(
    "dlr-deep",
    "领裤把德拉·深勾",
    "德拉勾深入并影响对手髋线，膝盖保持向外打开而非扭转膝关节。深勾适合进入 De La X、倒转和取背链，但需持续管理对手远腿。",
    "guard",
    "bottom",
    ["Deep De La Riva"],
    ["深勾", "倒转", "取背"],
  ),
  position(
    "dlr-hip-frame",
    "领裤把德拉·远脚顶髋",
    "自由脚踩住远侧髋部，形成肩线与髋线的对角张力。脚掌保持主动、膝盖不过度伸直，用于阻止压近并制造前后失衡。",
    "guard",
    "bottom",
    ["DLR hip frame"],
    ["框架", "距离", "远脚"],
  ),
  position(
    "dlr-biceps-frame",
    "领裤把德拉·远脚踩臂",
    "自由脚控制对手远侧上臂或肘线，形成蜘蛛式框架。适合对手用远手压腿时重新建立距离，也可切换为领袖开放防守。",
    "guard",
    "bottom",
    ["DLR biceps frame"],
    ["框架", "蜘蛛", "远脚"],
  ),
  position(
    "dlr-situp",
    "领裤把德拉·坐起位",
    "对手髋部后撤或近腿变轻时，下位沿裤把坐起并贴近膝线。胸口靠近大腿，头位在内侧，避免远距离伸手追腿。",
    "guard",
    "bottom",
    ["Sit-up De La Riva"],
    ["坐起", "抱单腿", "技术起身"],
  ),
  position(
    "dlr-underhook",
    "领裤把德拉·抱腿位",
    "下位手臂深入控制近腿，领把仍用于破坏姿势。膝肘保持紧密，头部贴近腿侧，为坐起扫、De La X 或 Matrix 分支做准备。",
    "guard",
    "bottom",
    ["Underhook De La Riva"],
    ["抱腿", "下潜", "取背"],
  ),
  position(
    "dlr-x",
    "De La X",
    "从深德拉或抱腿位进入的 X 形腿部控制。双腿共同抬升并转动对手近腿，手部持续控制裤腿或腿根，目标是扫倒、转 X Guard 或暴露后髋。",
    "guard",
    "bottom",
    ["De La X guard", "DLR X"],
    ["De La X", "腿部缠绕", "扫技"],
  ),
  position(
    "dlr-baby-bolo",
    "Baby Bolo",
    "下位围绕对手近侧髋部倒转，但尚未完全进入背后。控制膝线和腰髋，避免只用脚勾拉；根据对手转向进入 Crab Ride、腿拖或骑乘。",
    "guard",
    "bottom",
    ["Baby Berimbolo"],
    ["Bolo", "倒转", "取背"],
  ),
  position(
    "dlr-square-stance",
    "领裤把德拉·对手方正站姿",
    "对手双髋较为方正、远近腿差较小。此时先制造对角张力，再决定前拉、后推或让远脚重新找到髋部，不宜直接硬拉德拉勾。",
    "guard",
    "bottom",
    ["Square stance DLR"],
    ["对手反应", "方正站姿"],
  ),
  position(
    "dlr-hips-back",
    "领裤把德拉·对手后撤重心",
    "对手髋部远离并把重量放在后腿，近腿相对变轻。下位应减少仰躺追勾，沿裤把坐起，准备技术起身或抱单腿。",
    "guard",
    "bottom",
    ["Hips-back DLR reaction"],
    ["对手反应", "后撤", "坐起"],
  ),
  position(
    "dlr-forward-offbalance",
    "领裤把德拉·对手前倾失衡",
    "对手肩线越过膝线，手部或远脚需要落地支撑。保持领把拉力与裤把提拉，防止对手恢复姿势，并选择前向扫或绕后。",
    "guard",
    "bottom",
    ["Forward DLR off-balance"],
    ["失衡", "前向", "扫技"],
  ),
  position(
    "dlr-backward-offbalance",
    "领裤把德拉·对手后坐失衡",
    "对手重心落到后侧、近腿被伸直或臀部接近地面。下位保持膝线控制并及时起身，避免扫倒后仍停留在下位。",
    "guard",
    "bottom",
    ["Backward DLR off-balance"],
    ["失衡", "后向", "扫技"],
  ),
  position(
    "dlr-kneeling",
    "领裤把德拉·对手单膝落地",
    "对手主动或被迫让一侧膝盖落地，原德拉勾空间缩小。用领把控制上身，选择回到坐姿、转膝盾或等待对手重新站起。",
    "guard",
    "bottom",
    ["Kneeling DLR reaction"],
    ["对手反应", "单膝", "恢复"],
  ),
  position(
    "dlr-knee-inward-threat",
    "对手内旋膝切威胁",
    "对手把近膝向内旋并试图切过下位大腿。优先让膝线回到身体外侧，以自由脚和前臂建立框架，再切换反向德拉或膝盾。",
    "guard",
    "bottom",
    ["Knee-cut threat"],
    ["威胁", "膝切", "防守"],
  ),
  position(
    "dlr-backstep-threat",
    "对手反向跨步威胁",
    "对手远腿反向跨过并转动髋部，试图消除德拉勾或进入反向半防。下位需跟随髋部转向，控制膝线并建立反向德拉。",
    "guard",
    "bottom",
    ["Backstep threat"],
    ["威胁", "反向跨步", "防守"],
  ),
  position(
    "dlr-hook-cleared",
    "德拉勾被拆",
    "对手已把德拉脚从腿后清除，但领把或裤把可能仍在。不要用扭膝方式强行重新勾入；先用自由脚恢复距离，再回坐姿或转反向德拉。",
    "guard",
    "bottom",
    ["DLR hook cleared"],
    ["握把被拆", "恢复", "防守"],
  ),
  position(
    "dlr-collar-broken",
    "领把被拆",
    "裤把和腿部框架尚在，但对手上身恢复自由。保持膝肘距离与脚部框架，使用双裤把暂时稳定，或回到开放防守重建领把。",
    "guard",
    "bottom",
    ["Collar grip broken"],
    ["握把被拆", "领把", "恢复"],
  ),
  position(
    "dlr-pants-broken",
    "裤把被拆",
    "领把仍能影响姿势，但近腿控制已经松开。用自由手保护膝线并寻找袖把、脚踝把或重新抓裤，避免对手直接进入腿拖。",
    "guard",
    "bottom",
    ["Pants grip broken"],
    ["握把被拆", "裤把", "恢复"],
  ),
  position(
    "dlr-leg-drag-threat",
    "腿拖威胁",
    "对手把双腿推向同一侧并准备绕过髋部。下位必须让肩髋重新方正，用领把拉开上身距离，以反向德拉或坐姿重置阻断过腿。",
    "guard",
    "bottom",
    ["Leg-drag threat"],
    ["威胁", "腿拖", "防守"],
  ),
  position(
    "dlr-collar-sleeve",
    "领袖开放防守",
    "一手领把、一手袖把，以脚部框架管理两侧距离。它是裤把丢失后的稳定替代，也可在重新控制近侧裤腿后返回领裤把德拉。",
    "guard",
    "bottom",
    ["Collar sleeve guard"],
    ["替代防守", "领袖把", "恢复"],
  ),
  position(
    "dlr-ankle-grip",
    "脚踝把德拉",
    "下手控制脚踝而非裤脚，德拉勾与自由脚共同限制步伐。适合裤布难抓时维持结构，再沿腿向上换回裤把。",
    "guard",
    "bottom",
    ["Ankle-grip De La Riva"],
    ["握把变种", "脚踝把"],
  ),
  position(
    "dlr-double-pants",
    "双裤把德拉",
    "双手分别管理两条裤腿，牺牲领把来强化腿线控制。适合作为领把被拆后的过渡位，也可通过释放远侧裤把重新建立领口控制。",
    "guard",
    "bottom",
    ["Double pants De La Riva"],
    ["握把变种", "双裤把"],
  ),
  position(
    "dlr-reverse",
    "反向德拉",
    "对手内旋膝切、反向跨步或腿拖时，用反向勾与自由脚框架重新控制膝线。髋部跟随对手转向，但肩部避免被压平。",
    "guard",
    "bottom",
    ["Reverse De La Riva", "RDLR"],
    ["替代防守", "反向德拉", "防守"],
  ),
  position(
    "dlr-single-leg-x",
    "单腿 X",
    "下位髋部进入对手近腿下方，以单腿 X 结构控制膝线和髋线。膝夹紧但不挤压自身膝关节，准备扫技、转 X Guard 或直踝固。",
    "guard",
    "bottom",
    ["Single-leg X", "Ashi Garami"],
    ["腿部缠绕", "单腿X", "扫技"],
  ),
  position(
    "dlr-x-guard",
    "X Guard",
    "下位位于对手重心下方，双腿形成 X 形支撑并控制一条腿。持续抬高对手髋部，选择技术起身、后向扫或重新进入单腿 X。",
    "guard",
    "bottom",
    ["X-Guard"],
    ["腿部缠绕", "X Guard", "扫技"],
  ),
  position(
    "dlr-knee-shield",
    "膝盾半防",
    "对手落膝或切膝时的保底位置。膝盾管理肩线，另一腿控制近腿；先恢复侧身和内侧框架，再等待对手站起或重新进入开放防守。",
    "guard",
    "bottom",
    ["Knee-shield half guard"],
    ["替代防守", "膝盾", "半防"],
  ),
  position(
    "dlr-single-leg-standup",
    "坐起抱单腿·站立完成位",
    "下位已经技术起身并保持近腿控制，头位在内侧、背部挺直。此处不再停留于防守，应连接跑管、内侧绊或迫使对手坐地。",
    "standing",
    "neutral",
    ["Technical stand-up single leg"],
    ["抱单腿", "技术起身", "扫技"],
  ),
  position(
    "dlr-top-open",
    "扫倒后上位开放位",
    "扫倒完成后，下位已经起身成为上位，但尚未稳定过腿。保持裤腿或脚踝控制，先阻止对手重新坐起，再选择切膝或腿拖。",
    "control",
    "top",
    ["Top open guard after sweep"],
    ["扫技终点", "上位", "过腿"],
  ),
  position(
    "dlr-knee-cut-control",
    "切膝控制位",
    "上位膝盖越过对手大腿，正在用头肩控制和内侧夹腿稳定切膝。先固定上身与髋线，再完全抽出被夹的脚。",
    "control",
    "top",
    ["Knee-cut control"],
    ["过腿", "切膝", "控制"],
  ),
  position(
    "dlr-leg-drag-control",
    "腿拖控制位",
    "上位将对手双腿引向同侧并占据髋部外侧。胸口压住大腿、膝盖封住髋部，根据对手转向进入侧压或背后控制。",
    "control",
    "top",
    ["Leg drag control"],
    ["过腿", "腿拖", "控制"],
  ),
  position(
    "dlr-crab-ride",
    "Crab Ride",
    "已经绕到对手髋部后方，以双腿和手部控制腰髋，但尚未建立完整背后控制。保持胸髋连接，优先阻止对手转身面对你。",
    "control",
    "top",
    ["Crab ride"],
    ["取背", "髋部控制", "Bolo"],
  ),
  position(
    "dlr-side-control",
    "侧压",
    "扫技与过腿链的稳定终点之一。控制头肩与远侧髋部，确认双腿已经越过后再切换骑乘或背后控制。",
    "control",
    "top",
    ["Side control"],
    ["终点", "侧压", "控制"],
  ),
  position(
    "dlr-mount",
    "骑乘位",
    "对手在取背或腿拖防守中转向正面时进入骑乘。膝盖收紧髋线，先稳定平衡和上身控制，再考虑进一步攻击。",
    "control",
    "top",
    ["Mount"],
    ["终点", "骑乘", "控制"],
  ),
  position(
    "dlr-back-control",
    "背后控制",
    "Bolo、Matrix 或腿拖分支的主要终点。先建立安全带与髋部控制，再完成双钩或身体三角；不要为了抢第二钩丢失上身连接。",
    "control",
    "top",
    ["Back control"],
    ["终点", "取背", "控制"],
  ),
  position(
    "dlr-matrix",
    "Matrix 入口",
    "从抱腿德拉穿入远侧腿后并转动髋部，开始绕向对手背后。持续控制膝线和腰髋；若背后通道关闭，可转 Crab Ride 或回到深德拉。",
    "guard",
    "bottom",
    ["Matrix back-take entry"],
    ["Matrix", "倒转", "取背", "高级"],
  ),
  position(
    "dlr-kiss-dragon",
    "Kiss of the Dragon 中间位",
    "从反向德拉倒转进入对手髋部下方，准备绕到后侧。头部与肩部保持安全，双腿持续跟随髋线，避免在对手重量下停留。",
    "guard",
    "bottom",
    ["Kiss of the Dragon"],
    ["反向德拉", "倒转", "取背", "高级"],
  ),
  position(
    "dlr-straight-ankle-control",
    "直踝固控制位",
    "从单腿 X 保持膝线与髋线控制并建立直踝固夹持。先确认训练规则与搭档安全，膝盖夹紧、脚腕置于前臂刀口，逐步施压。",
    "submission",
    "neutral",
    ["Straight ankle lock control"],
    ["腿锁", "直踝固", "终结"],
  ),
];

const techniques = [
  technique("dlr-tech-safe-sit", "dlr-standing-entry", "dlr-seated-entry", "安全坐入领裤把", "领把先限制对手上身，后撤一脚并以手和脚控制下降速度。坐下后立即让膝盖位于肘内，避免双腿平放。", "foundation", ["入口", "坐姿"]),
  technique("dlr-tech-establish-base", "dlr-seated-entry", "dlr-base", "建立领裤把德拉", "裤把固定近侧膝线，外侧脚绕入德拉勾，自由脚先找到远侧髋部。确认膝盖朝向安全后再制造张力。", "foundation", ["入口", "德拉勾"]),
  technique("dlr-tech-reset-seated", "dlr-open-reset", "dlr-seated-entry", "重置坐姿与握把", "用双脚框架建立距离，侧身坐起，先恢复领把再寻找近侧裤把。不要在对手压近时同时伸出双手。", "foundation", ["恢复", "坐姿"]),
  technique("dlr-tech-collar-sleeve-switch", "dlr-collar-sleeve", "dlr-base", "袖把换近侧裤把", "远脚继续控制上肢，释放近侧袖把抓住裤脚或膝侧裤布，再让外侧脚进入德拉勾。", "foundation", ["握把切换", "入口"]),
  technique("dlr-tech-ankle-climb", "dlr-ankle-grip", "dlr-base", "脚踝把上爬裤把", "保持脚踝不能后撤，手沿裤腿上爬到稳定裤把；换把瞬间用自由脚阻止对手压近。", "foundation", ["握把切换"]),
  technique("dlr-tech-double-pants-collar", "dlr-double-pants", "dlr-base", "双裤把补领把", "保留近侧裤把，远手释放裤腿并建立领口控制。领把成形后重新拉开肩膝对角张力。", "foundation", ["握把切换"]),
  technique("dlr-tech-base-to-ankle", "dlr-base", "dlr-ankle-grip", "裤把滑脱转脚踝把", "裤布开始脱手时向下追到脚踝，先保住腿线与步伐控制，再寻找重新上爬的时机。", "foundation", ["恢复", "握把切换"]),
  technique("dlr-tech-base-to-double-pants", "dlr-base", "dlr-double-pants", "领把受压转双裤把", "对手集中拆领时，用领把手接管远侧裤腿；双脚持续框架，避免换把时上身失去距离。", "intermediate", ["恢复", "握把切换"]),
  technique("dlr-tech-shallow-reset", "dlr-base", "dlr-shallow", "浅勾快速重置", "对手拔高近腿时先缩短德拉勾，以脚背挂住小腿外侧，配合裤把防止腿完全退出。", "foundation", ["浅勾", "保持"]),
  technique("dlr-tech-redeepen-hook", "dlr-shallow", "dlr-base", "膝线内重新加深", "用领把拉低姿势、自由脚推开髋部，待近腿变轻后把德拉脚重新绕深，不用膝关节硬扭。", "foundation", ["德拉勾", "恢复"]),
  technique("dlr-tech-enter-deep", "dlr-base", "dlr-deep", "穿入深德拉", "先让对手近腿承重变轻，再延伸德拉脚并让膝盖向外打开。裤把持续贴近自身髋部以控制膝线。", "intermediate", ["深勾", "倒转"]),
  technique("dlr-tech-deep-to-base", "dlr-deep", "dlr-base", "回收标准德拉勾", "当倒转通道关闭时，缩回深勾并恢复远脚髋部框架，重新让肩线和膝线受控。", "foundation", ["恢复", "德拉勾"]),
  technique("dlr-tech-add-hip-frame", "dlr-base", "dlr-hip-frame", "远脚建立髋部框架", "脚掌放在远侧髋骨附近，膝盖保持微屈。领把拉、远脚推，建立对角张力而不是把对手直线推远。", "foundation", ["框架", "失衡"]),
  technique("dlr-tech-hip-frame-return", "dlr-hip-frame", "dlr-base", "回收远脚管理远腿", "对手绕开髋部时收回自由脚，改为勾、踩或挡住远腿，保持髋部面向对手。", "foundation", ["框架", "保持"]),
  technique("dlr-tech-add-biceps-frame", "dlr-base", "dlr-biceps-frame", "远脚转上臂框架", "对手远手压腿时，以脚掌控制肘上方并伸展其肩线；领把手保持肘部贴近身体。", "intermediate", ["框架", "蜘蛛"]),
  technique("dlr-tech-biceps-return", "dlr-biceps-frame", "dlr-base", "收脚回髋恢复基础位", "对手抽回手臂时让自由脚先回到髋线，再决定踩髋或管理远腿，避免脚悬空被腿拖。", "foundation", ["框架", "恢复"]),
  technique("dlr-tech-situp-entry", "dlr-base", "dlr-situp", "沿裤把坐起", "对手髋部后撤时屈膝收脚，沿裤把把胸口靠近近腿；另一手或脚维持距离，头位进入安全内侧。", "foundation", ["坐起", "抱单腿"]),
  technique("dlr-tech-situp-return", "dlr-situp", "dlr-base", "坐起位回落重建框架", "对手重新向前压时先放回自由脚框架，再有控制地回落到侧髋，恢复德拉勾和领把张力。", "foundation", ["恢复", "框架"]),
  technique("dlr-tech-underhook-entry", "dlr-base", "dlr-underhook", "下潜抱住近腿", "用远脚与领把让近腿变轻，身体侧转并让手臂深入腿后。头部贴近大腿，避免手臂孤立伸长。", "intermediate", ["抱腿", "下潜"]),
  technique("dlr-tech-underhook-situp", "dlr-underhook", "dlr-situp", "抱腿带动坐起", "保持膝肘连接，以抱腿手把膝线拉近，同时用另一脚帮助髋部靠前，进入可以技术起身的距离。", "foundation", ["坐起", "抱单腿"]),
  technique("dlr-tech-square-reaction", "dlr-base", "dlr-square-stance", "识别方正站姿", "对手把双髋转正并平均分配重量。先保留双侧距离控制，观察其重心再选择前拉或后推。", "foundation", ["对手反应", "判断"]),
  technique("dlr-tech-square-forward", "dlr-square-stance", "dlr-forward-offbalance", "领拉裤提前向破姿势", "领把向对角下方拉，裤把提起并向外带，自由脚阻止远腿后撤，让对手肩线越过膝线。", "foundation", ["失衡", "前向"]),
  technique("dlr-tech-square-backward", "dlr-square-stance", "dlr-backward-offbalance", "髋推勾拉后向失衡", "远脚推髋、德拉勾拉近腿，双手保持肩膝对角控制，使对手重心落向脚跟。", "intermediate", ["失衡", "后向"]),
  technique("dlr-tech-hips-back-reaction", "dlr-base", "dlr-hips-back", "识别髋部后撤", "对手主动把臀部拉远并减轻近腿负重。不要伸直手臂追握，立即缩短身体与腿的距离。", "foundation", ["对手反应", "判断"]),
  technique("dlr-tech-hips-back-situp", "dlr-hips-back", "dlr-situp", "后撤时追身坐起", "借裤把把身体拉近，不是把对手硬拉回来。自由脚收回地面或控制远腿，为技术起身建立底座。", "foundation", ["坐起", "抱单腿"]),
  technique("dlr-tech-kneeling-reaction", "dlr-base", "dlr-kneeling", "迫使或识别单膝落地", "前后失衡后对手以一膝落地恢复平衡。保持领把，不让对手直接压平下位肩线。", "foundation", ["对手反应", "判断"]),
  technique("dlr-tech-kneeling-knee-shield", "dlr-kneeling", "dlr-knee-shield", "落膝时转膝盾保底", "德拉勾空间消失时收腿，以近膝放在胸肩之间，另一腿控制对手膝线，恢复侧身。", "foundation", ["防守", "膝盾"]),
  technique("dlr-tech-knee-shield-stand", "dlr-knee-shield", "dlr-base", "对手站起时重建德拉", "对手从膝盾位抬高髋部时保留领把，近腿重新穿出并建立裤把和德拉勾。", "intermediate", ["恢复", "德拉勾"]),
  technique("dlr-tech-knee-inward-reaction", "dlr-base", "dlr-knee-inward-threat", "识别内旋膝切", "对手近膝指向内侧并压过大腿时，不再加深传统德拉勾；先用框架保护膝线。", "foundation", ["威胁", "膝切"]),
  technique("dlr-tech-knee-inward-rdlr", "dlr-knee-inward-threat", "dlr-reverse", "内旋时切换反向德拉", "收回原德拉勾，从近腿内侧建立反向勾，自由脚管理远侧髋或肩，跟随对手髋部转向。", "intermediate", ["防守", "反向德拉"]),
  technique("dlr-tech-rdlr-square", "dlr-reverse", "dlr-base", "髋部回正后重新穿德拉", "对手放弃内旋并重新方正时，先用脚部框架创造空间，再让外侧脚回到传统德拉勾。", "intermediate", ["恢复", "反向德拉"]),
  technique("dlr-tech-knee-inward-shield", "dlr-knee-inward-threat", "dlr-knee-shield", "框架转膝盾", "无法建立反向勾时，以前臂和自由脚阻止肩部压近，收回膝盖形成膝盾半防。", "foundation", ["防守", "膝盾"]),
  technique("dlr-tech-backstep-reaction", "dlr-base", "dlr-backstep-threat", "识别反向跨步", "对手远腿跨过并转髋时，立刻松开会扭膝的勾法，保留裤把并让髋部跟随旋转。", "foundation", ["威胁", "反向跨步"]),
  technique("dlr-tech-backstep-rdlr", "dlr-backstep-threat", "dlr-reverse", "跟髋建立反向德拉", "下位转向对手新髋线，以反向勾和自由脚框架阻止其落到侧压。", "intermediate", ["防守", "反向德拉"]),
  technique("dlr-tech-rdlr-kiss", "dlr-reverse", "dlr-kiss-dragon", "反向德拉倒转绕髋", "先抬高并越过对手重心线，再倒转进入髋下。全程控制近腿，避免在颈部受压时强行旋转。", "advanced", ["倒转", "取背", "Kiss of the Dragon"]),
  technique("dlr-tech-kiss-back", "dlr-kiss-dragon", "dlr-back-control", "绕髋完成背后控制", "双腿跟随髋部绕到后侧，先建立安全带或腰髋控制，再补双钩。", "advanced", ["取背", "终点"]),
  technique("dlr-tech-hook-clear-reaction", "dlr-base", "dlr-hook-cleared", "识别德拉勾被拆", "对手拔腿或手拆勾后，立即停止扭膝追勾，确认自由脚仍在两人之间。", "foundation", ["对手反应", "恢复"]),
  technique("dlr-tech-hook-clear-seated", "dlr-hook-cleared", "dlr-seated-entry", "勾被拆后坐姿重置", "用领把阻止对手直立远离，双脚回到前方，侧身坐起并重新寻找裤把与勾入角度。", "foundation", ["恢复", "坐姿"]),
  technique("dlr-tech-hook-clear-rdlr", "dlr-hook-cleared", "dlr-reverse", "拆勾瞬间捕捉反向德拉", "对手向内跨步拆勾时，收腿从内侧建立反向勾并让髋部跟随其膝线。", "intermediate", ["恢复", "反向德拉"]),
  technique("dlr-tech-collar-break-reaction", "dlr-base", "dlr-collar-broken", "识别领把被拆", "对手两手成功清除领把。保持裤把和脚部框架，不要立刻用无保护的手重新伸向领口。", "foundation", ["对手反应", "握把被拆"]),
  technique("dlr-tech-collar-break-double", "dlr-collar-broken", "dlr-double-pants", "失去领把转双裤把", "空手先控制远侧裤腿，让双腿无法自由绕过；稳定后再释放一手重建领把。", "foundation", ["恢复", "双裤把"]),
  technique("dlr-tech-collar-break-reset", "dlr-collar-broken", "dlr-open-reset", "失去上身控制时重置", "对手上身已压近时不要追领，先用双脚和前臂恢复距离，再回坐姿建立握把。", "foundation", ["恢复", "框架"]),
  technique("dlr-tech-pants-break-reaction", "dlr-base", "dlr-pants-broken", "识别裤把被拆", "近腿已经可以自由移动。领把继续拉低姿势，空手保护膝线并准备抓袖或脚踝。", "foundation", ["对手反应", "握把被拆"]),
  technique("dlr-tech-pants-break-sleeve", "dlr-pants-broken", "dlr-collar-sleeve", "失去裤把转领袖防守", "用空手控制对手压腿或抓裤的手袖，远脚转上臂框架，建立稳定领袖开放防守。", "foundation", ["恢复", "领袖把"]),
  technique("dlr-tech-pants-break-reset", "dlr-pants-broken", "dlr-open-reset", "裤把丢失后双脚回前", "无法及时抓袖或脚踝时，把双膝收回肘内，双脚放在髋肩线之间重置。", "foundation", ["恢复", "框架"]),
  technique("dlr-tech-leg-drag-reaction", "dlr-base", "dlr-leg-drag-threat", "识别双腿被拖向同侧", "对手控制双腿并绕向一侧时，肩部向反方向转回，领把拉开其上身，防止髋部被固定。", "foundation", ["威胁", "腿拖"]),
  technique("dlr-tech-leg-drag-rdlr", "dlr-leg-drag-threat", "dlr-reverse", "腿拖中转反向德拉", "让近腿从内侧重新连接对手膝线，自由脚推髋，髋部转回面对对手。", "intermediate", ["防守", "反向德拉"]),
  technique("dlr-tech-leg-drag-reset", "dlr-leg-drag-threat", "dlr-open-reset", "肩髋回正后坐姿重置", "用领把和远侧前臂创造距离，把双腿带回正面并侧身坐起。", "foundation", ["恢复", "坐姿"]),
  technique("dlr-tech-hip-frame-drag", "dlr-hip-frame", "dlr-leg-drag-threat", "远脚被压下形成腿拖威胁", "记录对手绕开髋部框架并把双腿压向同侧的常见反应，及时进入腿拖防守链。", "foundation", ["对手反应", "腿拖"]),
  technique("dlr-tech-forward-offbalance", "dlr-base", "dlr-forward-offbalance", "领拉裤提前向失衡", "领把向下拉过膝线，裤把向外上方提起，自由脚限制远腿后撤，让对手用手或远脚支撑。", "foundation", ["失衡", "前向"]),
  technique("dlr-tech-forward-sweep", "dlr-forward-offbalance", "dlr-top-open", "前向倾倒扫起身", "保持近腿被提起，在对手支撑方向相反侧继续拉推。对手落地后立刻收腿起身，保持裤腿控制。", "intermediate", ["扫技", "起身"]),
  technique("dlr-tech-backward-offbalance", "dlr-base", "dlr-backward-offbalance", "髋推勾拉后向失衡", "远脚推髋，德拉勾和裤把拉近腿，领把阻止对手上身前移恢复平衡。", "foundation", ["失衡", "后向"]),
  technique("dlr-tech-backward-sweep", "dlr-backward-offbalance", "dlr-top-open", "后倒扫后技术起身", "对手臀部落地时保持裤把，收回双脚并侧身起立。先控制双腿再开始过腿。", "foundation", ["扫技", "技术起身"]),
  technique("dlr-tech-base-single-leg", "dlr-base", "dlr-single-leg-standup", "领裤把坐起抱单腿", "对手后撤时沿裤把坐起，头位进入内侧，德拉脚回收成为起身底座，完成技术起身。", "foundation", ["抱单腿", "技术起身"]),
  technique("dlr-tech-situp-stand", "dlr-situp", "dlr-single-leg-standup", "坐起位技术起身", "一手保持腿部控制，另一手或脚建立支点；胸口贴腿、背部挺直后起身。", "foundation", ["抱单腿", "技术起身"]),
  technique("dlr-tech-underhook-stand", "dlr-underhook", "dlr-single-leg-standup", "抱腿位直接起身", "抱腿手锁紧膝线，外侧脚回地并把髋部带到身体下方，站起后保持头位安全。", "intermediate", ["抱单腿", "技术起身"]),
  technique("dlr-tech-single-leg-finish", "dlr-single-leg-standup", "dlr-top-open", "抱单腿完成扫倒", "根据对手平衡选择跑管、内侧绊或迫使其坐地；落地后保持腿部控制并转为上位。", "foundation", ["抱单腿", "扫技"]),
  technique("dlr-tech-enter-slx", "dlr-base", "dlr-single-leg-x", "远脚穿髋转单腿 X", "先抬高近腿并让髋部进入其下方，自由脚穿到髋线形成单腿 X，双膝夹住膝线。", "intermediate", ["单腿X", "腿部缠绕"]),
  technique("dlr-tech-slx-sweep", "dlr-single-leg-x", "dlr-top-open", "单腿 X 倾倒扫", "持续抬髋并让对手膝盖离开稳定方向，以双腿和手部控制制造倾倒；保持腿后起身。", "intermediate", ["单腿X", "扫技"]),
  technique("dlr-tech-slx-xguard", "dlr-single-leg-x", "dlr-x-guard", "单腿 X 加深为 X Guard", "对手扩大站姿时，内侧腿进一步穿过并形成第二个支撑点，把髋部移动到其重心下方。", "intermediate", ["X Guard", "腿部缠绕"]),
  technique("dlr-tech-slx-ankle", "dlr-single-leg-x", "dlr-straight-ankle-control", "单腿 X 建立直踝固控制", "保留膝线控制，把脚腕置于前臂刀口并调整夹腿。训练中先确认规则，缓慢完成控制。", "intermediate", ["腿锁", "直踝固"]),
  technique("dlr-tech-deep-dlrx", "dlr-deep", "dlr-x", "深德拉转 De La X", "深勾抬高近腿，自由脚从内侧加入 X 形支撑，手部控制腿根或裤腿，髋部进入重心下方。", "intermediate", ["De La X", "腿部缠绕"]),
  technique("dlr-tech-underhook-dlrx", "dlr-underhook", "dlr-x", "抱腿位进入 De La X", "抱腿手把膝线拉近，双脚重新组织为 De La X；不要在手臂伸长时承受对手全部重量。", "intermediate", ["De La X", "抱腿"]),
  technique("dlr-tech-dlrx-xguard", "dlr-x", "dlr-x-guard", "De La X 加深 X Guard", "对手抽回被勾腿时让内侧脚继续穿深，移动髋部并建立完整 X 支撑。", "intermediate", ["X Guard", "腿部缠绕"]),
  technique("dlr-tech-dlrx-sweep", "dlr-x", "dlr-top-open", "De La X 倾倒扫", "双腿抬高并旋转近腿，手部保持裤腿控制；对手落地后沿腿起身成为上位。", "intermediate", ["De La X", "扫技"]),
  technique("dlr-tech-xguard-sweep", "dlr-x-guard", "dlr-top-open", "X Guard 后向扫起身", "让对手重心越过后脚，伸展双腿并保持近腿控制。落地后立即技术起身。", "intermediate", ["X Guard", "扫技"]),
  technique("dlr-tech-xguard-single", "dlr-x-guard", "dlr-single-leg-standup", "X Guard 技术起身抱单腿", "对手把重量移远时收回上方支撑，抱住近腿并让髋部回到脚下完成起身。", "intermediate", ["X Guard", "抱单腿"]),
  technique("dlr-tech-deep-bolo", "dlr-deep", "dlr-baby-bolo", "深勾倒转进入 Baby Bolo", "先让对手近髋变轻，肩部沿安全方向倒转，双手持续控制膝线和腰髋，不以颈部承担重量。", "advanced", ["Bolo", "倒转", "取背"]),
  technique("dlr-tech-base-bolo", "dlr-base", "dlr-baby-bolo", "标准领裤把 Bolo 入口", "通过后向失衡迫使对手坐髋，保留裤把并围绕近髋倒转，进入 Baby Bolo。", "advanced", ["Bolo", "倒转", "取背"]),
  technique("dlr-tech-bolo-crab", "dlr-baby-bolo", "dlr-crab-ride", "绕髋进入 Crab Ride", "双腿和手部沿髋线向后移动，先控制腰髋再抬起对手下侧髋部，阻止其转回正面。", "advanced", ["Bolo", "Crab Ride", "取背"]),
  technique("dlr-tech-crab-back", "dlr-crab-ride", "dlr-back-control", "Crab Ride 完成取背", "胸口贴近后背，建立安全带后再补第一钩；对手继续转动时让髋部跟随。", "intermediate", ["取背", "终点"]),
  technique("dlr-tech-crab-mount", "dlr-crab-ride", "dlr-mount", "对手转正时切换骑乘", "对手强行面向你时跨过髋线，让膝盖落到两侧并控制上身，避免执着于取背而丢位。", "intermediate", ["骑乘", "终点"]),
  technique("dlr-tech-bolo-drag", "dlr-baby-bolo", "dlr-leg-drag-control", "取背通道关闭转腿拖", "对手把后背贴地阻止绕后时，把双腿引向同侧并起身压住髋线，进入腿拖控制。", "advanced", ["Bolo", "腿拖", "过腿"]),
  technique("dlr-tech-underhook-matrix", "dlr-underhook", "dlr-matrix", "抱腿德拉进入 Matrix", "远腿通道出现时让自由脚和髋部穿入腿后，手部保持膝线控制并开始绕髋。", "advanced", ["Matrix", "倒转", "取背"]),
  technique("dlr-tech-matrix-crab", "dlr-matrix", "dlr-crab-ride", "Matrix 绕髋进入 Crab Ride", "持续控制远腿和腰髋，双腿绕到对手后侧后先固定髋部，再追上身。", "advanced", ["Matrix", "Crab Ride", "取背"]),
  technique("dlr-tech-matrix-back", "dlr-matrix", "dlr-back-control", "Matrix 直接完成取背", "对手后背暴露时建立安全带，髋部贴紧并补第一钩；若无法稳定则退回 Crab Ride。", "advanced", ["Matrix", "取背", "终点"]),
  technique("dlr-tech-top-knee-cut", "dlr-top-open", "dlr-knee-cut-control", "扫后连接切膝", "保持一侧裤腿控制，另一手建立上身控制，膝盖沿大腿内侧切入并固定头肩。", "foundation", ["过腿", "切膝"]),
  technique("dlr-tech-top-leg-drag", "dlr-top-open", "dlr-leg-drag-control", "扫后连接腿拖", "把对手双腿引向同侧，绕到髋部外侧并让胸口覆盖大腿，阻止其重新坐起。", "foundation", ["过腿", "腿拖"]),
  technique("dlr-tech-knee-cut-side", "dlr-knee-cut-control", "dlr-side-control", "抽脚稳定侧压", "头肩与远侧髋部先固定，脚尖向后抽出被夹腿，双膝重新落地后确认侧压。", "foundation", ["过腿", "侧压"]),
  technique("dlr-tech-drag-side", "dlr-leg-drag-control", "dlr-side-control", "腿拖绕髋进入侧压", "对手背部贴地时压住膝线并绕过髋部，胸口接管上身，进入侧压。", "foundation", ["过腿", "侧压"]),
  technique("dlr-tech-drag-back", "dlr-leg-drag-control", "dlr-back-control", "腿拖中捕捉背后", "对手转身逃离腿拖时先建立安全带，膝盖跟随髋部并补入第一钩。", "intermediate", ["腿拖", "取背"]),
  technique("dlr-tech-side-mount", "dlr-side-control", "dlr-mount", "侧压滑膝进入骑乘", "隔离远侧手臂并控制髋部，近膝跨过腰线；先稳定膝盖位置再释放侧压控制。", "foundation", ["骑乘", "控制"]),
];

const attachments = [
  {
    id: "dlr-note-system-guide",
    ownerType: "position",
    ownerId: "dlr-base",
    kind: "note",
    title: "系统阅读说明",
    value:
      "本库以勾腿侧为“近侧”，不固定左右。先掌握基础位、浅勾恢复、前后失衡与坐起抱单腿，再学习 De La X、Bolo、Matrix。动作是训练决策图，不代表在任何对手反应下都应强行完成。",
  },
  {
    id: "dlr-note-core-checklist",
    ownerType: "position",
    ownerId: "dlr-base",
    kind: "note",
    title: "基础位检查单",
    value:
      "1. 领把能否影响肩线；2. 裤把能否限制近膝转向；3. 德拉膝盖是否处于安全方向；4. 自由脚是否正在管理远侧髋、腿或手臂；5. 髋部是否仍面向对手；6. 下一步是让对手前倾、后坐还是后撤。",
  },
  {
    id: "dlr-note-defense-priority",
    ownerType: "position",
    ownerId: "dlr-knee-inward-threat",
    kind: "note",
    title: "膝切威胁优先级",
    value:
      "先保护膝线与肩线，再考虑保留原握把。若传统德拉勾使膝盖被迫内扭，应立即松开并改用反向德拉、膝盾或开放防守重置。",
  },
  {
    id: "dlr-note-finish-sweep",
    ownerType: "position",
    ownerId: "dlr-top-open",
    kind: "note",
    title: "扫倒不等于完成",
    value:
      "计分与实战都要求及时起身并稳定上位。扫倒后继续控制裤腿或脚踝，阻止对手重新坐起，优先连接切膝或腿拖。",
  },
];

async function applyLayout() {
  const elk = new ELK();
  const positionIds = new Set(positions.map(({ id }) => id));
  const graph = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "SPLINES",
      "elk.separateConnectedComponents": "true",
      "elk.spacing.componentComponent": "180",
      "elk.spacing.nodeNode": "90",
      "elk.layered.spacing.nodeNodeBetweenLayers": "210",
      "elk.layered.spacing.edgeNodeBetweenLayers": "72",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "40",
      "elk.layered.cycleBreaking.strategy": "GREEDY",
      "elk.layered.layering.strategy": "NETWORK_SIMPLEX",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    },
    children: positions.map(({ id }) => ({ id, width: 180, height: 82 })),
    edges: techniques
      .filter(
        ({ sourcePositionId, targetPositionId }) =>
          positionIds.has(sourcePositionId) &&
          targetPositionId !== null &&
          positionIds.has(targetPositionId),
      )
      .map(({ id, sourcePositionId, targetPositionId }) => ({
        id,
        sources: [sourcePositionId],
        targets: [targetPositionId],
      })),
  });
  const nodes = new Map((graph.children ?? []).map((node) => [node.id, node]));
  const minimumX = Math.min(...[...nodes.values()].map(({ x = 0 }) => x));
  const minimumY = Math.min(...[...nodes.values()].map(({ y = 0 }) => y));
  positions.forEach((item) => {
    const node = nodes.get(item.id);
    if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      throw new Error(`Automatic layout omitted ${item.id}`);
    }
    item.x = Math.round(node.x - minimumX + 120);
    item.y = Math.round(node.y - minimumY + 120);
  });
}

function assertPlan() {
  const positionIds = new Set(positions.map(({ id }) => id));
  const techniqueIds = new Set(techniques.map(({ id }) => id));
  const attachmentIds = new Set(attachments.map(({ id }) => id));
  if (positionIds.size !== positions.length) {
    throw new Error("Duplicate position IDs in seed data");
  }
  if (techniqueIds.size !== techniques.length) {
    throw new Error("Duplicate technique IDs in seed data");
  }
  if (attachmentIds.size !== attachments.length) {
    throw new Error("Duplicate attachment IDs in seed data");
  }
  techniques.forEach((item) => {
    if (
      !positionIds.has(item.sourcePositionId) ||
      (item.targetPositionId !== null &&
        !positionIds.has(item.targetPositionId)) ||
      item.sourcePositionId === item.targetPositionId
    ) {
      throw new Error(`Invalid technique endpoints: ${item.id}`);
    }
  });
  attachments.forEach((item) => {
    const validOwner =
      (item.ownerType === "position" && positionIds.has(item.ownerId)) ||
      (item.ownerType === "technique" && techniqueIds.has(item.ownerId));
    if (!validOwner) {
      throw new Error(`Invalid attachment owner: ${item.id}`);
    }
  });
}

function validateTargetDatabase(database) {
  const integrity = database.prepare("PRAGMA integrity_check").all();
  const foreignKeyFailures = database.prepare("PRAGMA foreign_key_check").all();
  const tableCounts = Object.fromEntries(
    ["positions", "techniques", "attachments"].map((table) => [
      table,
      database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
    ]),
  );
  const targetColumn = database
    .prepare("PRAGMA table_info(techniques)")
    .all()
    .find(({ name }) => name === "target_position_id");
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
    throw new Error(`Target database integrity failed: ${JSON.stringify(integrity)}`);
  }
  if (foreignKeyFailures.length > 0) {
    throw new Error(
      `Target database has foreign key failures: ${JSON.stringify(foreignKeyFailures)}`,
    );
  }
  if (!targetColumn || targetColumn.notnull !== 0) {
    throw new Error("Target database does not support unknown destinations");
  }
  if (Object.values(tableCounts).some((count) => count !== 0)) {
    throw new Error(
      `Target database is not empty: ${JSON.stringify(tableCounts)}`,
    );
  }
}

function insertPlan(database) {
  const insertPosition = database.prepare(
    `INSERT INTO positions (
      id, name, aliases_json, description, category, role, tags_json, x, y
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertTechnique = database.prepare(
    `INSERT INTO techniques (
      id, source_position_id, target_position_id, name, description,
      gi_mode, difficulty, tags_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertAttachment = database.prepare(
    `INSERT INTO attachments (
      id, owner_type, owner_id, kind, title, value, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;");
  try {
    positions.forEach((item) => {
      insertPosition.run(
        item.id,
        item.name,
        JSON.stringify(item.aliases),
        item.description,
        item.category,
        item.role,
        JSON.stringify(item.tags),
        item.x,
        item.y,
      );
    });
    techniques.forEach((item) => {
      insertTechnique.run(
        item.id,
        item.sourcePositionId,
        item.targetPositionId,
        item.name,
        item.description,
        item.giMode,
        item.difficulty,
        JSON.stringify(item.tags),
      );
    });
    const ownerOrder = new Map();
    attachments.forEach((item) => {
      const key = `${item.ownerType}:${item.ownerId}`;
      const sortOrder = ownerOrder.get(key) ?? 0;
      ownerOrder.set(key, sortOrder + 1);
      insertAttachment.run(
        item.id,
        item.ownerType,
        item.ownerId,
        item.kind,
        item.title,
        item.value,
        sortOrder,
      );
    });
    const integrity = database.prepare("PRAGMA integrity_check").all();
    const foreignKeyFailures = database.prepare("PRAGMA foreign_key_check").all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
      throw new Error(`Post-seed integrity failed: ${JSON.stringify(integrity)}`);
    }
    if (foreignKeyFailures.length > 0) {
      throw new Error(
        `Post-seed foreign keys failed: ${JSON.stringify(foreignKeyFailures)}`,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

await applyLayout();
assertPlan();

const database = new DatabaseSync(DATABASE_PATH, { readOnly: !APPLY });
try {
  validateTargetDatabase(database);
  const counts = {
    positions: positions.length,
    techniques: techniques.length,
    attachments: attachments.length,
  };
  const categories = Object.groupBy(positions, ({ category }) => category);
  const difficulties = Object.groupBy(
    techniques,
    ({ difficulty }) => difficulty,
  );
  console.log(APPLY ? "Collar-pants DLR seed APPLY" : "Collar-pants DLR seed DRY RUN");
  console.log(`Library: 领裤把德拉 (${LIBRARY_ID})`);
  console.log(`Database: ${DATABASE_PATH}`);
  console.log(`Planned: ${JSON.stringify(counts)}`);
  console.log(
    `Categories: ${Object.entries(categories)
      .map(([key, items]) => `${key}=${items.length}`)
      .join(", ")}`,
  );
  console.log(
    `Difficulty: ${Object.entries(difficulties)
      .map(([key, items]) => `${key}=${items.length}`)
      .join(", ")}`,
  );
  console.log("\nPositions:");
  positions.forEach(({ name, category, role }) => {
    console.log(`  ${name} [${category}/${role}]`);
  });
  console.log("\nTechnique groups:");
  const tagCounts = new Map();
  techniques.forEach(({ tags }) => {
    tags.slice(1).forEach((tag) => tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1));
  });
  console.log(
    [...tagCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 16)
      .map(([tag, count]) => `  ${tag}: ${count}`)
      .join("\n"),
  );

  if (APPLY) {
    insertPlan(database);
    console.log("\nSeed completed successfully.");
  } else {
    console.log("\nNo rows were changed. Re-run with --apply after review.");
  }
} finally {
  database.close();
}