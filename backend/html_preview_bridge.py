"""预览桥（内容源版）：资源 HTML 运行在独立内容源（跨域隔离，无 sandbox 功能限制）。
桥只做两件事：
- 同源 /api/files/ 资源请求补 token（img/script/CSS/Worker/importScripts 全覆盖）；
- 非 files 的 /api/ 业务请求改写回主源 + token（CORS 已放行）。
Worker/importScripts/wasm 在内容源原生运行，无需沙箱补丁。"""
from __future__ import annotations

import json
import re

BRIDGE_JS = """
(function(){
  var t='';
  try{ t=new URLSearchParams(location.search).get('token')||''; }catch(e){}
  var API_BASE=__API_BASE__;
  function fixU(u){
    try{
      var s=String(u);
      var r=new URL(s, location.href);
      if(r.pathname.indexOf('/api/')!==0||r.searchParams.get('token'))return s;
      if(r.pathname.indexOf('/api/files/')!==0&&API_BASE){ r=new URL(API_BASE+r.pathname+r.search); }
      if(t)r.searchParams.set('token', t);
      return r.href;
    }catch(e){ return String(u); }
  }
  if(t){
    var of=window.fetch;
    if(of)window.fetch=function(u,o){
      try{
        if(typeof u==='string')u=fixU(u);
        else if(u&&u.url)u=new Request(fixU(u.url),u);
      }catch(e){}
      return of.call(window,u,o);
    };
    var oo=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(m,u){
      try{ if(typeof u==='string')u=fixU(u); }catch(e){}
      return oo.apply(this,arguments);
    };
    window.__dynImport=function(u){ return import(fixU(u)); };
    window.__ftFetch=window.fetch;
    /* 原生资源（img/CSS url 等）：初始扫描 + 插入前重写 + MutationObserver 增量 */
    function fixAttr(el, name){
      try{
        var v=el.getAttribute(name);
        if(!v)return;
        if(name==='srcset'){
          var nv=v.split(',').map(function(seg){
            var p=seg.trim().split(/\\s+/);
            p[0]=fixU(p[0]);
            return p.join(' ');
          }).join(', ');
          if(nv!==v)el.setAttribute(name, nv);
          return;
        }
        var nv2=fixU(v);
        if(nv2!==v)el.setAttribute(name, nv2);
      }catch(e){}
    }
    function fixStyleText(s){
      return String(s).replace(/url\\(\\s*(['"]?)([^'")]+)\\1\\s*\\)/g, function(w, q, u){
        var n=fixU(u);
        return n===u ? w : 'url('+q+n+q+')';
      });
    }
    function fixEl(el){
      if(!el||el.nodeType!==1)return;
      var tag=el.tagName;
      if(tag==='IMG'||tag==='SCRIPT'||tag==='SOURCE'||tag==='VIDEO'||tag==='AUDIO'||tag==='IFRAME'||tag==='EMBED')fixAttr(el,'src');
      if(tag==='LINK'||tag==='A')fixAttr(el,'href');
      if(tag==='VIDEO')fixAttr(el,'poster');
      if(el.hasAttribute('srcset'))fixAttr(el,'srcset');
      if(el.hasAttribute('xlink:href'))fixAttr(el,'xlink:href');
      if(tag==='STYLE'){ var nv=fixStyleText(el.textContent); if(nv!==el.textContent)el.textContent=nv; }
      var sv=el.getAttribute('style');
      if(sv){ var nv2=fixStyleText(sv); if(nv2!==sv)el.setAttribute('style', nv2); }
    }
    function scan(root){
      try{
        fixEl(root);
        var els=root.querySelectorAll?root.querySelectorAll('img,script,source,video,audio,iframe,embed,link,a,style,[srcset],[style]'):[];
        for(var i=0;i<els.length;i++)fixEl(els[i]);
      }catch(e){}
    }
    function hookInsert(proto, name){
      var orig=proto[name];
      if(!orig)return;
      proto[name]=function(node){
        try{ if(node&&node.nodeType===1)fixEl(node); }catch(e){}
        return orig.apply(this, arguments);
      };
    }
    hookInsert(Node.prototype,'appendChild');
    hookInsert(Node.prototype,'insertBefore');
    hookInsert(Element.prototype,'append');
    hookInsert(Element.prototype,'prepend');
    /* Worker：blob 注入补权包装；URL 补 token（内容源无 sandbox，原生运行） */
    var OW=window.Worker;
    if(OW)window.Worker=function(u,o){
      try{
        var s=String(u);
        var isModule=o&&o.type==='module';
        if(!isModule){
          var x=new XMLHttpRequest(); x.open('GET', s.indexOf('blob:')===0?s:fixU(s), false); x.send();
          var pre='self.__FT_TOKEN__='+JSON.stringify(t)+';self.__API_BASE__='+JSON.stringify(API_BASE||'')+';'
            +'self.__fixU=function(u){try{var s=String(u);var r=new URL(s,self.location.href);if(r.pathname.indexOf("/api/")!==0||r.searchParams.get("token"))return s;if(r.pathname.indexOf("/api/files/")!==0&&self.__API_BASE__){r=new URL(self.__API_BASE__+r.pathname+r.search);}if(self.__FT_TOKEN__)r.searchParams.set("token",self.__FT_TOKEN__);return r.href;}catch(e){return s;}};'
            +'self.fetch=(function(of){return function(u,o){try{u=self.__fixU(typeof u==="string"?u:(u&&u.url)||"");}catch(e){}return of.call(this,u,o);};})(self.fetch);'
            +'self.__ftFetch=self.fetch;'
            +'if(self.importScripts)self.importScripts=(function(of){return function(){var a=[].map.call(arguments,function(v){return self.__fixU(v);});return of.apply(this,a);};})(self.importScripts);'
            +'if(!self.__dynImport)self.__dynImport=function(v){return import(self.__fixU(v));};';
          u=URL.createObjectURL(new Blob([pre+x.responseText],{type:'application/javascript'}));
        } else { u=fixU(s); }
      }catch(e){}
      return new OW(u,o);
    };
    if(document.documentElement)scan(document.documentElement);
    document.addEventListener('DOMContentLoaded', function(){ scan(document.documentElement); });
    try{
      var mo=new MutationObserver(function(muts){
        for(var i=0;i<muts.length;i++){
          var mu=muts[i];
          if(mu.type==='attributes')fixEl(mu.target);
          else if(mu.type==='childList'){ for(var j=0;j<mu.addedNodes.length;j++)scan(mu.addedNodes[j]); }
          else if(mu.type==='characterData'&&mu.target.parentElement&&mu.target.parentElement.tagName==='STYLE')fixEl(mu.target.parentElement);
        }
      });
      mo.observe(document.documentElement, {subtree:true, childList:true, attributes:true,
        attributeFilter:['src','href','srcset','style','poster','xlink:href'], characterData:true});
    }catch(e){}
  }
})();
"""


def inject_preview_bridge(html: str, api_base: str | None = None) -> str:
    """把桥脚本插为 head 内第一个脚本；api_base 为主源地址（业务 /api/ 回主源）。"""
    js = BRIDGE_JS.replace("__API_BASE__", json.dumps(api_base or ""))
    tag = "<script>" + js + "</script>"
    m = re.search(r"<head[^>]*>", html, re.I)
    if m:
        return html[:m.end()] + tag + html[m.end():]
    m = re.search(r"<html[^>]*>", html, re.I)
    if m:
        return html[:m.end()] + "<head>" + tag + "</head>" + html[m.end():]
    return tag + html
