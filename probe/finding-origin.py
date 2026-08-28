"""每条被检出的缺陷，是原稿自带的，还是返修过程自己造出来的。

**不调模型、不写库、不花钱。** 与 `revision-granularity.py` 读同一批数据。

判定：引文闸门（D-11）保证一条 finding 的引文逐字出现在当轮那一稿里。
所以问题只剩「它在第 0 稿里有没有」——往回查它最早出现在第几稿：
第 0 稿就有 = 原稿自带；第 1 稿及以后才出现 = **返修写出来的**。

这个数比附带改动率更要紧：附带改动只是代价，返修新造的缺陷是**净损失**，
它还要再吃掉一轮预算，吃完了就带病发货。

用法（对副本跑）：
    python3 probe/finding-origin.py /tmp/copy.sqlite

结果见 skills/scene-review/RELIABILITY.md 的「19% 的缺陷是返修自己造出来的」。
"""

import json
import re
import sqlite3
import sys

QUOTE_PATTERN = re.compile(r'[“”„«»‘’"\'＂＇]')
WHITESPACE = re.compile(r"\s+")


def normalize(text):
    return WHITESPACE.sub("", QUOTE_PATTERN.sub('"', text))


def main(db_path):
    con = sqlite3.connect(db_path)
    slots = con.execute(
        """SELECT task_id, slot_id, content_text FROM slots
            WHERE revision_round > 0 AND content_text IS NOT NULL
            ORDER BY task_id, slot_id"""
    ).fetchall()

    print(f"{'任务/槽位':<32}{'轮':>3}{'判据':>5}  引文最早出现在")
    print("-" * 84)
    from_original = introduced = missing = 0

    for task_id, slot_id, final in slots:
        row = con.execute(
            """SELECT context_json FROM executions
                WHERE task_id=? AND target_slot_id=? AND operation='fill_slot'
                  AND status='succeeded'
                ORDER BY attempt_number DESC LIMIT 1""",
            (task_id, slot_id),
        ).fetchone()
        prior = json.loads(row[0])["revision"]["priorRounds"]
        drafts = [normalize(p["submittedContent"]) for p in prior] + [normalize(final)]

        reviews = con.execute(
            """SELECT round, criterion_id, findings_json FROM slot_reviews
                WHERE task_id=? AND slot_id=? AND verdict='revise'
                ORDER BY round, criterion_id""",
            (task_id, slot_id),
        ).fetchall()

        for rnd, criterion, findings_json in reviews:
            for finding in json.loads(findings_json):
                quote = normalize(finding["quote"])
                first = next((i for i in range(len(drafts)) if quote in drafts[i]), None)
                if first is None:
                    # 不该发生：引文闸门放行意味着它在当轮那稿里逐字存在。
                    # 真出现了说明 priorRounds 与裁决对不上，先查那个，别信这一行。
                    source = "？任何一稿里都找不到——先查 priorRounds 与裁决是否错位"
                    missing += 1
                elif first == 0:
                    source = "第 0 稿（原稿自带）"
                    from_original += 1
                else:
                    source = f"**第 {first} 稿（返修写出来的）**"
                    introduced += 1
                print(f"{task_id[:8] + '/' + slot_id:<32}{rnd:>3}{criterion:>5}  {source}")

    print("-" * 84)
    total = from_original + introduced
    if total:
        print(
            f"合计 {total} 条被检出的缺陷：原稿自带 {from_original} 条，"
            f"返修新造 {introduced} 条（{introduced / total * 100:.0f}%）"
            + (f"，另有 {missing} 条对不上帐" if missing else "")
        )
    else:
        print("库里没有发生过返修的槽位。")


if __name__ == "__main__":
    main(sys.argv[1])
