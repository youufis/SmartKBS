/* eslint-disable */
// 修复 antd v6 ColProps 索引签名覆盖 children 的问题
// 通过全局 JSX 命名空间增强 Col 组件的类型
import 'antd';

declare module 'antd' {
  // 覆盖 Col 组件的 props 类型，使其正确支持 children
  type _ColProps = import('react').PropsWithChildren<{
    span?: number | string;
    order?: number | string;
    offset?: number | string;
    push?: number | string;
    pull?: number | string;
    flex?: number | string;
    xs?: number | string | { span?: number | string; order?: number | string; offset?: number | string };
    sm?: number | string | { span?: number | string; order?: number | string; offset?: number | string };
    md?: number | string | { span?: number | string; order?: number | string; offset?: number | string };
    lg?: number | string | { span?: number | string; order?: number | string; offset?: number | string };
    xl?: number | string | { span?: number | string; order?: number | string; offset?: number | string };
    xxl?: number | string | { span?: number | string; order?: number | string; offset?: number | string };
    prefixCls?: string;
    className?: string;
    style?: import('react').CSSProperties;
    key?: import('react').Key;
    id?: string;
    [key: string]: unknown;
  }>;

  export const Col: import('react').ForwardRefExoticComponent<_ColProps & import('react').RefAttributes<HTMLDivElement>>;
}
