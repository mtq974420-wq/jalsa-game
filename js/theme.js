/* يشتغل قبل ما تنرسم الصفحة:
   - يمنع تضمين اللعبة داخل موقع ثاني (حماية من النقر الخادع)
   - يطبّق الوضع الليلي أو العادي عشان ما ترمش الصفحة */
(function () {
  if (window.top !== window.self) {
    document.documentElement.style.display = "none";
    try { window.top.location = window.location.href; } catch (e) {}
    return;
  }
  try {
    var t = localStorage.getItem("bara_theme") || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    document.documentElement.dataset.theme = t;
  } catch (e) { document.documentElement.dataset.theme = "dark"; }
})();
