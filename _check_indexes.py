import sqlite3
conn = sqlite3.connect('D:\\SmartKBS\\backend\\smartkb.db')
c = conn.cursor()
for table in ['courses', 'chapters', 'knowledge_points', 'curriculum_bindings', 'learning_progress']:
    c.execute(f'PRAGMA table_info({table})')
    cols = [r[1] for r in c.fetchall()]
    c.execute(f'PRAGMA index_list({table})')
    idx = [r[2] for r in c.fetchall()]
    print(f'{table}:')
    print(f'  列: {cols}')
    print(f'  索引: {idx if idx else "(无)"}')
    print()
