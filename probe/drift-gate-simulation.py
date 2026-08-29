"""漂移闸门能不能用阈值来做：拿历史数据把它跑一遍。

**不调模型、不写库、不花钱。** 数据与 `revision-granularity.py` / `finding-origin.py` 同源。

── 它要回答的问题 ──────────────────────────────────────────────

返修会造缺陷（`finding-origin.py`：27 条被检出的缺陷里 5 条是返修写出来的）。
最便宜的机械对策是**漂移闸门**：模型照旧提交全文，系统拿它和上一稿对账，
未被点名的部分改动超过阈值 T 就打回重写。

这个方案成不成立，全看一件事：**附带改动率能不能把「会造缺陷的返修」
和「不会造缺陷的返修」分开。** 分不开，阈值就无处可放——
定低了把好返修全打回（每打回一次是一次完整重写的钱），
定高了该拦的一条都拦不住。

这个问题**不需要花一分钱**就能答：两边的数据库里都有。

用法（对副本跑）：
    python3 probe/drift-gate-simulation.py /tmp/copy.sqlite

结论见 skills/scene-review/RELIABILITY.md。
"""

import difflib
import json
import re
import sqlite3
import sys

QUOTE_PATTERN = re.compile(r'[“”„«»‘’"\'＂＇]')
WHITESPACE = re.compile(r"\s+")
SENTENCE = re.compile(r"[^。！？…\n]*[。！？…\n]|[^。！？…\n]+")

THRESHOLDS = [0, 5, 10, 15, 20, 30, 50]


def normalize(text):
    return WHITESPACE.sub("", QUOTE_PATTERN.sub('"', text))


def sentences(text):
    return [s for s in SENTENCE.findall(text) if s.strip()]


def collect(con):
    """每一次返修一行：附带改动率，以及它有没有把新缺陷写进正文。"""
    rows = []
    for task_id, slot_id, final in con.execute(
        """SELECT task_id, slot_id, content_text FROM slots
            WHERE revision_round > 0 AND content_text IS NOT NULL
            ORDER BY task_id, slot_id"""
    ).fetchall():
        ctx = con.execute(
            """SELECT context_json FROM executions
                WHERE task_id=? AND target_slot_id=? AND operation='fill_slot'
                  AND status='succeeded'
                ORDER BY attempt_number DESC LIMIT 1""",
            (task_id, slot_id),
        ).fetchone()
        prior = json.loads(ctx[0])["revision"]["priorRounds"]
        drafts = [p["submittedContent"] for p in prior] + [final]
        norm_drafts = [normalize(d) for d in drafts]

        # 每条被检出的缺陷，它的引文最早出现在第几稿。first>0 = 返修写出来的，
        # 而写出它的那次返修是 drafts[first-1] → drafts[first]，即第 first-1 轮那次。
        introduced_by = {}
        for rnd, findings_json in con.execute(
            """SELECT round, findings_json FROM slot_reviews
                WHERE task_id=? AND slot_id=? AND verdict='revise'""",
            (task_id, slot_id),
        ).fetchall():
            for finding in json.loads(findings_json):
                quote = normalize(finding["quote"])
                first = next((i for i in range(len(norm_drafts)) if quote in norm_drafts[i]), None)
                if first is not None and first > 0:
                    introduced_by[first - 1] = introduced_by.get(first - 1, 0) + 1

        for i, round_data in enumerate(prior):
            old, new = drafts[i], drafts[i + 1]
            quotes = [q for q in (normalize(f["quote"]) for f in round_data["findings"]) if q]
            old_sents = sentences(old)

            matcher = difflib.SequenceMatcher(
                None, [normalize(s) for s in old_sents], [normalize(s) for s in sentences(new)]
            )
            changed = set()
            for tag, i1, i2, _, _ in matcher.get_opcodes():
                if tag != "equal":
                    changed.update(range(i1, i2))
            flagged = {
                j
                for j, s in enumerate(old_sents)
                if any(q in normalize(s) or normalize(s) in q for q in quotes)
            }

            old_chars = sum(len(normalize(s)) for s in old_sents)
            collateral = sum(len(normalize(old_sents[j])) for j in changed - flagged)
            rows.append(
                {
                    "label": f"{task_id[:8]}/{slot_id}",
                    "round": i,
                    "collateral_pct": collateral / old_chars * 100 if old_chars else 0,
                    "introduced": introduced_by.get(i, 0),
                }
            )
    return rows


def main(db_path):
    rows = collect(sqlite3.connect(db_path))

    print(f"{'槽位':<32}{'轮':>3}{'附带改动':>10}{'这次返修造出的新缺陷':>22}")
    print("-" * 68)
    for r in sorted(rows, key=lambda r: r["collateral_pct"]):
        mark = f"{r['introduced']} 条" if r["introduced"] else "—"
        print(f"{r['label']:<32}{r['round']:>3}{r['collateral_pct']:>9.1f}%{mark:>20}")

    total_bad = sum(1 for r in rows if r["introduced"] > 0)
    print("-" * 68)
    print(f"{len(rows)} 次返修，其中 {total_bad} 次把新缺陷写进了正文\n")

    print("把附带改动率当闸门用，阈值扫一遍：")
    print(f"{'阈值':>6}{'打回':>6}{'拦住的坏返修':>14}{'误伤的好返修':>14}{'漏掉的坏返修':>14}")
    print("-" * 56)
    for t in THRESHOLDS:
        rejected = [r for r in rows if r["collateral_pct"] > t]
        caught = sum(1 for r in rejected if r["introduced"] > 0)
        false_rejects = sum(1 for r in rejected if r["introduced"] == 0)
        missed = total_bad - caught
        print(f"{t:>5}%{len(rejected):>6}{caught:>12}/{total_bad}{false_rejects:>14}{missed:>14}")

    print(
        "\n读法：要拦住全部坏返修，阈值得压到误伤大多数好返修的位置；"
        "\n放到只误伤少数的位置，坏返修就漏掉大半。**中间没有可用的落点，"
        "\n就说明附带改动率不是一个能拿来做闸门的判别量。**"
        f"\n（n={len(rows)}，坏返修只有 {total_bad} 次——这个结论的强度到此为止。）"
    )


if __name__ == "__main__":
    main(sys.argv[1])
