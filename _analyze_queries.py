import sqlite3, time
conn = sqlite3.connect('D:\\SmartKBS\\backend\\smartkb.db')
c = conn.cursor()

# 统计课程表大小
for table in ['courses', 'chapters', 'knowledge_points', 'learning_progress']:
    c.execute(f'SELECT COUNT(*) FROM {table}')
    print(f'{table}: {c.fetchone()[0]} 行')

# 模拟树查询调用次数
c.execute("SELECT id FROM courses WHERE status='active'")
course_ids = [r[0] for r in c.fetchall()]
print(f'\n活跃课程数: {len(course_ids)}')

total_queries = 0
for cid in course_ids:
    # 查询顶层章节
    c.execute("SELECT id FROM chapters WHERE course_id=? AND parent_id IS NULL AND status='active'", (cid,))
    top_chs = c.fetchall()
    total_queries += 1
    for ch in top_chs:
        # 每个章节：查子章节 + 查知识点
        c.execute("SELECT id FROM chapters WHERE parent_id=? AND status='active'", (ch[0],))
        children = c.fetchall()
        total_queries += 1  # children query
        c.execute("SELECT id FROM knowledge_points WHERE chapter_id=? AND status='active'", (ch[0],))
        kps = c.fetchall()
        total_queries += 1  # kp query
        # 递归子章节
        for child in children:
            c.execute("SELECT id FROM chapters WHERE parent_id=? AND status='active'", (child[0],))
            total_queries += 1
            c.execute("SELECT id FROM knowledge_points WHERE chapter_id=? AND status='active'", (child[0],))
            total_queries += 1

print(f'总查询数(模拟): ~{total_queries} 次 SQL')
print(f'优化后只需: ~{len(course_ids) * 3} 次 SQL（课程+章节+知识点批量查询）')
