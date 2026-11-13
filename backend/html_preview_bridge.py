"""预览桥：沙箱 iframe（无 allow-same-origin）内 cookie/localStorage 不可用，
生成的互动 HTML 直接 fetch /api/ 会 401、读 localStorage 会抛错整页中断。

交付层在 HTML 的 <head> 最前注入一段桥脚本：
- 从 iframe URL 的 ?token= 取身份，给同源 /api/ 请求（fetch/XHR）自动附加 token；
- 提供 localStorage/cookie 安全 shim，避免沙箱内直接访问抛 SecurityError。
不放宽 sandbox：共享 HTML 仍是不可信内容，桥只传递"打开者自己的"令牌。
"""
from __future__ import annotations

import re

BRIDGE_JS = """
(function(){
  var t='';
  try{ t=new URLSearchParams(location.search).get('token')||''; }catch(e){}
  function withToken(u){
    try{
      var s=String(u);
      var ok=s.indexOf('/api/')===0||s.indexOf('api/')===0||s.indexOf(location.origin+'/api/')===0;
      if(!ok||/[?&]token=/.test(s))return u;
      return s+(s.indexOf('?')>=0?'&':'?')+'token='+encodeURIComponent(t);
    }catch(e){ return u; }
  }
  if(t){
    var of=window.fetch;
    if(of)window.fetch=function(u,o){
      try{
        if(typeof u==='string')u=withToken(u);
        else if(u&&u.url)u=new Request(withToken(u.url),u);
      }catch(e){}
      return of.call(window,u,o);
    };
    var oo=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(m,u){
      try{ if(typeof u==='string')u=withToken(u); }catch(e){}
      return oo.apply(this,arguments);
    };
  }
  try{
    var mem={};
    Object.defineProperty(window,'localStorage',{configurable:true,value:{
      getItem:function(k){return k in mem?mem[k]:null;},
      setItem:function(k,v){mem[k]=String(v);},
      removeItem:function(k){delete mem[k];},
      clear:function(){mem={};},
      key:function(i){return Object.keys(mem)[i]||null;},
      get length(){return Object.keys(mem).length;}
    }});
  }catch(e){}
  try{ Object.defineProperty(document,'cookie',{configurable:true,get:function(){return '';},set:function(v){}}); }catch(e){}
})();
"""


def inject_preview_bridge(html: str) -> str:
    """把桥脚本插为 head 内第一个脚本，保证先于任何业务脚本执行。"""
    tag = "<script>" + BRIDGE_JS + "</script>"
    m = re.search(r"<head[^>]*>", html, re.I)
    if m:
        return html[:m.end()] + tag + html[m.end():]
    m = re.search(r"<html[^>]*>", html, re.I)
    if m:
        return html[:m.end()] + "<head>" + tag + "</head>" + html[m.end():]
    return tag + html
