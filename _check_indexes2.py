import sqlite3
conn = sqlite3.connect('D:\\SmartKBS\\backend\\smartkb.db')
c = conn.cursor()
for table in ['courses', 'chapters', 'knowledge_points', 'curriculum_bindings', 'learning_progress']:
    c.execute(f'PRAGMA index_list({table})')
    indexes = c.fetchall()
    for idx in indexes:
        name = idx[1]
        unique = idx[2]
        c.execute(f'PRAGMA index_info({name})')
        cols = [r[2] for r in c.fetchall()]
        print(f'{table}: {name} (unique={unique}) -> {cols}')
