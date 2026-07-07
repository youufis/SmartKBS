/**
 * 登录页教育名言
 * 根据当前语言选择对应的名言列表
 */
import { useLocaleStore } from '../stores/localeStore'

export interface EduQuote {
  text: string
  author?: string
}

/** 中文教育名言 */
const ZH_QUOTES: EduQuote[] = [
  { text: '学而不思则罔，思而不学则殆。', author: '孔子' },
  { text: '知之者不如好之者，好之者不如乐之者。', author: '孔子' },
  { text: '温故而知新，可以为师矣。', author: '孔子' },
  { text: '学而时习之，不亦说乎？', author: '孔子' },
  { text: '三人行，必有我师焉。择其善者而从之，其不善者而改之。', author: '孔子' },
  { text: '有教无类。', author: '孔子' },
  { text: '因材施教。', author: '孔子' },
  { text: '敏而好学，不耻下问。', author: '孔子' },
  { text: '学而不厌，诲人不倦。', author: '孔子' },
  { text: '授人以鱼不如授人以渔。', author: '《老子》' },
  { text: '千里之行，始于足下。', author: '《老子》' },
  { text: '青，取之于蓝而青于蓝。', author: '荀子' },
  { text: '不积跬步，无以至千里；不积小流，无以成江海。', author: '荀子' },
  { text: '学不可以已。', author: '荀子' },
  { text: '玉不琢，不成器；人不学，不知道。', author: '《礼记》' },
  { text: '教学相长也。', author: '《礼记》' },
  { text: '师者，所以传道受业解惑也。', author: '韩愈' },
  { text: '业精于勤，荒于嬉；行成于思，毁于随。', author: '韩愈' },
  { text: '书山有路勤为径，学海无涯苦作舟。', author: '韩愈' },
  { text: '黑发不知勤学早，白首方悔读书迟。', author: '颜真卿' },
  { text: '纸上得来终觉浅，绝知此事要躬行。', author: '陆游' },
  { text: '问渠那得清如许？为有源头活水来。', author: '朱熹' },
  { text: '读书百遍，其义自见。', author: '陈寿' },
  { text: '路漫漫其修远兮，吾将上下而求索。', author: '屈原' },
  { text: '博学之，审问之，慎思之，明辨之，笃行之。', author: '《中庸》' },
  { text: '少壮不努力，老大徒伤悲。', author: '《长歌行》' },
  { text: '宝剑锋从磨砺出，梅花香自苦寒来。', author: '《警世贤文》' },
  { text: '立志宜思真品格，读书须尽苦功夫。', author: '阮元' },
  { text: '教育不是注满一桶水，而是点燃一把火。', author: '叶芝' },
  { text: '教育的根是苦的，但果实是甜的。', author: '亚里士多德' },
  { text: '教育是一个灵魂唤醒另一个灵魂。', author: '雅斯贝尔斯' },
  { text: '我听见了就忘了，我看见了就记住了，我做了就理解了。', author: '蒙台梭利' },
  { text: '教育的目的在于使人能够继续教育自己。', author: '杜威' },
  { text: '每个孩子都是一颗种子，只是花期不同。', author: '蒙台梭利' },
  { text: '想象力比知识更重要。', author: '爱因斯坦' },
  { text: '教育的最高目标是培养有独立思考能力的人。', author: '康德' },
  { text: '捧着一颗心来，不带半根草去。', author: '陶行知' },
  { text: '千教万教，教人求真；千学万学，学做真人。', author: '陶行知' },
  { text: '生活即教育，社会即学校，教学做合一。', author: '陶行知' },
  { text: '行是知之始，知是行之成。', author: '陶行知' },
  { text: '没有爱就没有教育。', author: '陶行知' },
  { text: '知识改变命运，教育成就未来。' },
  { text: '教育的本质是让人成为更好的自己。' },
  { text: '学习的意义不在于获得答案，而在于提出更好的问题。' },
]

/** 英文教育名言 */
const EN_QUOTES: EduQuote[] = [
  { text: 'Education is not the filling of a pail, but the lighting of a fire.', author: 'W. B. Yeats' },
  { text: 'The roots of education are bitter, but the fruit is sweet.', author: 'Aristotle' },
  { text: 'I hear and I forget. I see and I remember. I do and I understand.', author: 'Maria Montessori' },
  { text: 'Education is not preparation for life; education is life itself.', author: 'John Dewey' },
  { text: 'The art of teaching is the art of assisting discovery.', author: 'Mark Van Doren' },
  { text: 'Imagination is more important than knowledge.', author: 'Albert Einstein' },
  { text: 'Education is the most powerful weapon which you can use to change the world.', author: 'Nelson Mandela' },
  { text: 'The beautiful thing about learning is that nobody can take it away from you.', author: 'B. B. King' },
  { text: 'Tell me and I forget. Teach me and I remember. Involve me and I learn.', author: 'Benjamin Franklin' },
  { text: 'The mind is not a vessel to be filled, but a fire to be kindled.', author: 'Plutarch' },
  { text: 'Learning is not the product of teaching. Learning is the product of the activity of learners.', author: 'John Holt' },
  { text: 'Education is the kindling of a flame, not the filling of a vessel.', author: 'Socrates' },
  { text: 'Every child is a different kind of flower, and all together make this world a beautiful garden.', author: 'Unknown' },
  { text: 'The influence of a good teacher can never be erased.', author: 'Unknown' },
  { text: 'Education is not the learning of facts, but the training of the mind to think.', author: 'Albert Einstein' },
  { text: 'Learning is a treasure that will follow its owner everywhere.', author: 'Chinese Proverb' },
  { text: 'A teacher affects eternity; he can never tell where his influence stops.', author: 'Henry Adams' },
  { text: 'The purpose of education is to enable people to continue educating themselves.', author: 'John Dewey' },
  { text: 'Teaching is the one profession that creates all other professions.', author: 'Unknown' },
  { text: 'The best teachers are those who show you where to look, but don\'t tell you what to see.', author: 'Alexandra K. Trenfor' },
  { text: 'Education is the passport to the future, for tomorrow belongs to those who prepare for it today.', author: 'Malcolm X' },
  { text: 'Live as if you were to die tomorrow. Learn as if you were to live forever.', author: 'Mahatma Gandhi' },
  { text: 'The more that you read, the more things you will know. The more that you learn, the more places you\'ll go.', author: 'Dr. Seuss' },
  { text: 'Change is the end result of all true learning.', author: 'Leo Buscaglia' },
  { text: 'Education is not just about going to school and getting a degree. It\'s about widening your knowledge and absorbing the truth about life.', author: 'Shakuntala Devi' },
  { text: 'Learning never exhausts the mind.', author: 'Leonardo da Vinci' },
  { text: 'The whole purpose of education is to turn mirrors into windows.', author: 'Sydney J. Harris' },
  { text: 'An investment in knowledge pays the best interest.', author: 'Benjamin Franklin' },
  { text: 'Education is what remains after one has forgotten what one has learned in school.', author: 'Albert Einstein' },
  { text: 'The job of an educator is to teach students to see the vitality in themselves.', author: 'Joseph Campbell' },
  { text: 'Intelligence plus character — that is the goal of true education.', author: 'Martin Luther King Jr.' },
  { text: 'It is the mark of an educated mind to be able to entertain a thought without accepting it.', author: 'Aristotle' },
  { text: 'The function of education is to teach one to think intensively and to think critically.', author: 'Martin Luther King Jr.' },
  { text: 'What sculpture is to a block of marble, education is to the soul.', author: 'Joseph Addison' },
  { text: 'The great aim of education is not knowledge but action.', author: 'Herbert Spencer' },
  { text: 'To educate a person in mind and not in morals is to educate a menace to society.', author: 'Theodore Roosevelt' },
  { text: 'He who opens a school door, closes a prison.', author: 'Victor Hugo' },
]

/** 获取当前语言对应的名言列表 */
export function getQuotes(): EduQuote[] {
  const locale = useLocaleStore.getState().current
  return locale === 'en' ? EN_QUOTES : ZH_QUOTES
}

/** 随机选一条名言 */
export function getRandomQuote(): EduQuote {
  const quotes = getQuotes()
  return quotes[Math.floor(Math.random() * quotes.length)]
}
