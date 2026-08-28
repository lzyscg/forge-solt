"""返修粒度：为修一条 finding，附带改动了正文的多少。

**不调模型、不写库、不花钱。** 数据全部是已经躺在库里的：
旧稿在 `executions.context_json` 的 `revision.priorRounds[].submittedContent`，
末稿是 `slots.content_text`，两者拼起来就是完整的逐稿序列。

引文归一化与 `src/server/domain/review-evidence.ts` 的 `normalizeForComparison`
同源（`QUOTE_PATTERN` 折成一种引号 + 删掉全部空白）。两边不一致的话，
这里算出来的「被点名」会和引文闸门实际认的不是一回事。

用法（**对副本跑，不要直接开 data/ 下的库**）：
    cp data/forge-core.sqlite /tmp/copy.sqlite
    python3 probe/revision-granularity.py /tmp/copy.sqlite

结果与解读见 skills/scene-review/RELIABILITY.md 的「返修粒度：量出来了」。
注意那一节记着的否定结论：**附带改动率不能预测哪次返修会造出新缺陷**（n=10）。
"""

import difflib
import json
import re
import sqlite3
import sys

QUOTE_PATTERN = re.compile(r'[“”„«»‘’"\'＂＇]')
WHITESPACE = re.compile(r"\s+")


def normalize(text):
    return WHITESPACE.sub("", QUOTE_PATTERN.sub('"', text))


# 中文断句：标点后断，保留标点；换行也算边界。切不准会让「被改句数」虚高，
# 所以表里同时给字级改动率做对照——两个数差太远时要人工抽样复核。
SENTENCE = re.compile(r"[^。！？…\n]*[。！？…\n]|[^。！？…\n]+")


def sentences(text):
    return [s for s in SENTENCE.findall(text) if s.strip()]


def main(db_path):
    con = sqlite3.connect(db_path)
    slots = con.execute(
        """SELECT task_id, slot_id, content_text FROM slots
            WHERE revision_round > 0 AND content_text IS NOT NULL
            ORDER BY task_id, slot_id"""
    ).fetchall()

    header = ("任务/槽位", "轮", "旧稿字数", "被点名", "附带改动", "附带占比", "字级改动率")
    print(f"{header[0]:<34}{header[1]:>3}{header[2]:>9}{header[3]:>8}{header[4]:>9}{header[5]:>9}{header[6]:>10}")
    print("-" * 82)

    total_old = total_flagged = total_collateral = 0

    for task_id, slot_id, final in slots:
        row = con.execute(
            """SELECT context_json FROM executions
                WHERE task_id=? AND target_slot_id=? AND operation='fill_slot'
                  AND status='succeeded'
                ORDER BY attempt_number DESC LIMIT 1""",
            (task_id, slot_id),
        ).fetchone()
        prior = json.loads(row[0]).get("revision", {}).get("priorRounds", [])
        drafts = [p["submittedContent"] for p in prior] + [final]

        for i, round_data in enumerate(prior):
            old, new = drafts[i], drafts[i + 1]
            quotes = [normalize(f["quote"]) for f in round_data["findings"]]
            quotes = [q for q in quotes if q]

            old_sents = sentences(old)
            matcher = difflib.SequenceMatcher(
                None, [normalize(s) for s in old_sents], [normalize(s) for s in sentences(new)]
            )
            changed = set()
            for tag, i1, i2, _, _ in matcher.get_opcodes():
                if tag != "equal":
                    changed.update(range(i1, i2))

            # 被点名 = 句子落在某条引文里，或某条引文落在句子里。
            # 引文常常横跨句号，所以两个方向都要看。
            flagged = {
                j
                for j, s in enumerate(old_sents)
                if any(q in normalize(s) or normalize(s) in q for q in quotes)
            }

            old_chars = sum(len(normalize(s)) for s in old_sents)
            flagged_chars = sum(len(normalize(old_sents[j])) for j in flagged)
            collateral = sum(len(normalize(old_sents[j])) for j in changed - flagged)
            char_ratio = 1 - difflib.SequenceMatcher(None, normalize(old), normalize(new)).ratio()

            label = f"{task_id[:8]}/{slot_id}"
            pct = collateral / old_chars * 100 if old_chars else 0
            print(
                f"{label:<34}{i:>3}{old_chars:>9}{flagged_chars:>8}{collateral:>9}"
                f"{pct:>8.1f}%{char_ratio * 100:>9.1f}%"
            )
            total_old += old_chars
            total_flagged += flagged_chars
            total_collateral += collateral

    print("-" * 82)
    if total_old:
        print(
            f"{'合计':<34}{'':>3}{total_old:>9}{total_flagged:>8}{total_collateral:>9}"
            f"{total_collateral / total_old * 100:>8.1f}%"
        )
    else:
        print("库里没有发生过返修的槽位。")


if __name__ == "__main__":
    main(sys.argv[1])
