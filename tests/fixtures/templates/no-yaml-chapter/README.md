# 这个目录**刻意不含 template.yaml**

它存在的唯一理由，是让「failures 不许带绝对路径」那条断言真的有反证能力。

原来的坏模板只有 `broken-chapter`，而它的失败发生在**编译期**
（`status` 取值非法 → TEMPLATE_INVALID），报错里本来就没有路径。
于是 `expect(response.body).not.toContain(TEMPLATES_DIR)` 在那个样本下恒为真——
断言写对了，样本没覆盖到它想守的那一类错误，泄露存在也不会变红。

这个目录触发的是**读文件失败**那条路径（TEMPLATE_NOT_FOUND），
它是唯一会把 `sourcePath` 拼进 message 的分支。
