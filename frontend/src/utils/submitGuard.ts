/**
 * 交卷前的「未答确认」闸门（P0 防误交）。
 *
 * 考试、随堂测验、AI 智能练习都是一次定局：提交后不能修改，考试还要消耗一次答题机会。
 * 之前考试只是弹一条提示、随后照样提交，手滑一下就是交白卷；随堂测验连提示都没有。
 * 这里统一成阻断式确认：没答完必须明确点「仍然提交」才会交，点「回去补答」留在原地。
 */
import { Modal } from "antd"
import i18n from "../i18n"

/** 未作答的题号（1 起，按页面显示顺序）；由调用方给出「这题算不算答了」 */
export function unansweredIndexes<T>(items: T[], isAnswered: (item: T, index: number) => boolean): number[] {
  const miss: number[] = []
  items.forEach((item, i) => { if (!isAnswered(item, i)) miss.push(i + 1) })
  return miss
}

/**
 * 文案一律从 common 命名空间取：调用方各自的 t 绑的是 exam / interaction 等命名空间，
 * 传进来会查不到键、直接把键名显示给学生（第一版就踩了这个坑）。
 * 插值变量用 n 而不是 count —— count 是 i18next 的复数保留字。
 */
export function confirmUnanswered(opts: {
  /** 未作答的题号列表（1 起） */
  missing: number[]
  /** 总题数，用于区分「部分未答」和「一道没答」 */
  total: number
  /** 追加提醒，由各页面用自身命名空间的文案传入，例如「提交后不能修改，并会消耗一次答题机会」 */
  extra?: string
}): Promise<boolean> {
  const { missing, total, extra } = opts
  const t = (key: string, options?: Record<string, unknown>): string =>
    String(i18n.t(`common:${key}`, options ?? {}))
  if (!missing.length) return Promise.resolve(true)
  const list = missing.length > 12 ? missing.slice(0, 12).join("、") + " …" : missing.join("、")
  return new Promise((resolve) => {
    Modal.confirm({
      title: missing.length === total ? t("guardAllBlankTitle") : t("guardUnansweredTitle", { n: missing.length }),
      content: [t("guardUnansweredList", { list }), extra || ""].filter(Boolean).join(" "),
      okText: t("guardStillSubmit"),
      cancelText: t("guardKeepAnswering"),
      okButtonProps: { danger: true },
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    })
  })
}
