import React from 'react';
import { Col as AntdCol } from 'antd';
import type { ColProps as AntdColProps } from 'antd/es/grid/col';

// antd v6 的 ColProps 有索引签名问题，导致 TS2530 错误
// 此处用 Omit 去掉索引签名，保留所有已知属性
export type ColProps = Omit<AntdColProps, 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl'> & {
  children?: React.ReactNode;
  xs?: number | string | { span?: number | string; order?: number | string; offset?: number | string };
  sm?: number | string | { span?: number | string; order?: number | string; offset?: number | string };
  md?: number | string | { span?: number | string; order?: number | string; offset?: number | string };
  lg?: number | string | { span?: number | string; order?: number | string; offset?: number | string };
  xl?: number | string | { span?: number | string; order?: number | string; offset?: number | string };
  xxl?: number | string | { span?: number | string; order?: number | string; offset?: number | string };
};

export const Col = React.forwardRef<HTMLDivElement, ColProps>((props, ref) => {
  return <AntdCol ref={ref} {...props as any} />;
});

Col.displayName = 'Col';
