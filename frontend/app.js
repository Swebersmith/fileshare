(function () {
  const path = window.location.pathname.replace(/\/$/, "");

  if (path === "/bundle" || path === "/bundle.html") { initBundlePage(); }
  else if (path.includes("download")) { initDownloadPage(); }
  else { initUploadPage(); }

  // ==================== Upload Page ====================
  function initUploadPage() {
    const dropZone = document.getElementById("upload-area");
    const fileInput = document.getElementById("file-input");
    const fileListEl = document.getElementById("file-list");
    const uploadBtn = document.getElementById("upload-btn");
    const progress = document.getElementById("progress");
    const progressFill = document.getElementById("progress-fill");
    const progressText = document.getElementById("progress-text");
    const result = document.getElementById("result");
    const singleResult = document.getElementById("single-result");
    const shareLink = document.getElementById("share-link");
    const copyBtn = document.getElementById("copy-btn");
    const multiResult = document.getElementById("multi-result");
    const copyMsg = document.getElementById("copy-msg");

    let selectedFiles = [];

    dropZone.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("click", (e) => e.stopPropagation());

    dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("drag-over");
      addFiles(Array.from(e.dataTransfer.files));
    });

    fileInput.addEventListener("change", () => {
      addFiles(Array.from(fileInput.files));
      fileInput.value = "";
    });

    function addFiles(files) {
      for (const f of files) {
        if (!selectedFiles.find((sf) => sf.name === f.name && sf.size === f.size)) {
          selectedFiles.push(f);
        }
      }
      renderFileList();
    }

    function renderFileList() {
      fileListEl.innerHTML = selectedFiles.map((f, i) =>
        '<div class="file-item"><span>' + esc(f.name) + ' (' + formatSize(f.size) + ')</span><button class="remove-btn" data-idx="' + i + '">&times;</button></div>'
      ).join("");
      fileListEl.querySelectorAll(".remove-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          selectedFiles.splice(parseInt(btn.dataset.idx), 1);
          renderFileList();
        });
      });
      uploadBtn.disabled = selectedFiles.length === 0;
      result.classList.add("hidden");
      progress.classList.add("hidden");
    }

    uploadBtn.addEventListener("click", () => {
      if (selectedFiles.length === 0) return;
      uploadFiles();
    });

    copyBtn.addEventListener("click", () => {
      shareLink.select();
      navigator.clipboard?.writeText(shareLink.value);
      copyMsg.classList.remove("hidden");
      setTimeout(() => copyMsg.classList.add("hidden"), 3000);
    });

    function uploadFiles() {
      uploadBtn.disabled = true;
      progress.classList.remove("hidden");

      const formData = new FormData();
      for (const f of selectedFiles) formData.append("file", f);
      formData.append("expiry", document.getElementById("expiry").value);
      formData.append("password", document.getElementById("password").value);
      formData.append("mode", document.querySelector('input[name="mode"]:checked').value);

      const xhr = new XMLHttpRequest();

      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          progressFill.style.width = pct + "%";
          progressText.textContent = pct + "%";
        }
      });

      xhr.addEventListener("load", () => {
        try {
          const data = JSON.parse(xhr.responseText);
          progress.classList.add("hidden");
          result.classList.remove("hidden");

          if (data.bundleId) {
            singleResult.classList.remove("hidden");
            multiResult.classList.add("hidden");
            const base = location.origin + "/bundle?id=" + data.bundleId;
            shareLink.value = base;
            if (data.password) shareLink.value += " (密码: " + data.password + ")";
          } else if (data.files) {
            singleResult.classList.add("hidden");
            multiResult.classList.remove("hidden");
            multiResult.innerHTML = data.files.map((f) => {
              const link = location.origin + "/download?id=" + f.id;
              return '<div class="result-item"><span class="name">' + esc(f.name) + '</span><button class="copy-btn" data-link="' + esc(link) + '">复制链接</button></div>';
            }).join("");
            if (data.password) {
              multiResult.innerHTML += '<p class="copy-msg" style="margin-top:8px;color:#94a3b8">密码: ' + esc(data.password) + '</p>';
            }
            multiResult.querySelectorAll(".copy-btn").forEach((btn) => {
              btn.addEventListener("click", () => {
                navigator.clipboard?.writeText(btn.dataset.link);
                btn.textContent = "已复制";
                setTimeout(() => btn.textContent = "复制链接", 2000);
              });
            });
          }
        } catch (_) {
          alert("上传失败: " + xhr.responseText);
        }
        uploadBtn.disabled = false;
      });

      xhr.addEventListener("error", () => { alert("上传失败: 网络错误"); uploadBtn.disabled = false; });
      xhr.open("POST", "/api/upload");
      xhr.send(formData);
    }
  }

  // ==================== Download Page ====================
  function initDownloadPage() {
    const params = new URLSearchParams(window.location.search);
    const fileId = params.get("id");

    const fileInfo = document.getElementById("file-info");
    const detailName = document.getElementById("detail-name");
    const detailSize = document.getElementById("detail-size");
    const passwordSection = document.getElementById("password-section");
    const errorSection = document.getElementById("error-section");
    const globalError = document.getElementById("global-error");
    const downloadBtn = document.getElementById("download-btn");
    const verifyBtn = document.getElementById("verify-btn");
    const dlPassword = document.getElementById("dl-password");
    const passwordError = document.getElementById("password-error");
    const loading = document.getElementById("loading");

    if (!fileId) { showError("缺少文件 ID"); return; }

    let fileData = null;
    let downloadToken = null;

    fetch("/api/files/" + encodeURIComponent(fileId))
      .then((r) => r.json())
      .then((data) => {
        loading.classList.add("hidden");
        if (data.error) { showError(data.error); return; }
        fileData = data;
        detailName.textContent = data.name;
        detailSize.textContent = formatSize(data.size);
        fileInfo.classList.remove("hidden");
        if (data.hasPassword) { passwordSection.classList.remove("hidden"); }
        else { downloadBtn.classList.remove("hidden"); }
      })
      .catch(() => { loading.classList.add("hidden"); showError("加载失败"); });

    if (verifyBtn) {
      verifyBtn.addEventListener("click", () => {
        const pw = dlPassword.value.trim();
        if (!pw) return;
        passwordError.classList.add("hidden");
        fetch("/api/files/" + encodeURIComponent(fileId) + "/verify", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }),
        })
          .then((r) => r.json())
          .then((data) => {
            if (data.error) { passwordError.textContent = data.error; passwordError.classList.remove("hidden"); return; }
            downloadToken = data.token;
            passwordSection.classList.add("hidden");
            downloadBtn.classList.remove("hidden");
          });
      });
    }

    downloadBtn.addEventListener("click", () => {
      let url = "/api/download/" + encodeURIComponent(fileId);
      if (downloadToken) url += "?token=" + encodeURIComponent(downloadToken);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileData?.name || "";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });

    function showError(msg) { loading.classList.add("hidden"); errorSection.classList.remove("hidden"); globalError.textContent = msg; }
  }

  // ==================== Bundle Page ====================
  function initBundlePage() {
    const params = new URLSearchParams(window.location.search);
    const bundleId = params.get("id");
    const loading = document.getElementById("loading");
    const bundleContent = document.getElementById("bundle-content");
    const bundleList = document.getElementById("bundle-list");
    const passwordSection = document.getElementById("password-section");
    const errorSection = document.getElementById("error-section");
    const globalError = document.getElementById("global-error");
    const verifyBtn = document.getElementById("verify-btn");
    const dlPassword = document.getElementById("dl-password");
    const passwordError = document.getElementById("password-error");

    if (!bundleId) { showError("缺少合集 ID"); return; }

    fetch("/api/bundle/" + encodeURIComponent(bundleId))
      .then((r) => r.json())
      .then((data) => {
        loading.classList.add("hidden");
        if (data.error) { showError(data.error); return; }
        bundleContent.classList.remove("hidden");
        bundleList.innerHTML = data.files.map((f) =>
          '<div class="bundle-item"><div class="info"><div class="name">' + esc(f.name) + '</div><div class="size">' + formatSize(f.size) + '</div></div><button class="btn-dl" data-id="' + f.id + '" data-has-pw="' + f.hasPassword + '">下载</button></div>'
        ).join("");
        bundleList.querySelectorAll(".btn-dl").forEach((btn) => {
          btn.addEventListener("click", () => {
            const fid = btn.dataset.id;
            const hasPw = btn.dataset.hasPw === "true";
            if (hasPw) {
              const pw = prompt("此文件需要密码:");
              if (!pw) return;
              fetch("/api/files/" + fid + "/verify", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }),
              })
                .then((r) => r.json())
                .then((d) => {
                  if (d.error) { alert(d.error); return; }
                  downloadFile(fid, d.token);
                });
            } else {
              downloadFile(fid, null);
            }
          });
        });
      })
      .catch(() => { loading.classList.add("hidden"); showError("加载失败"); });

    function downloadFile(id, token) {
      let url = "/api/download/" + encodeURIComponent(id);
      if (token) url += "?token=" + encodeURIComponent(token);
      const a = document.createElement("a");
      a.href = url;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }

    function showError(msg) { loading.classList.add("hidden"); errorSection.classList.remove("hidden"); globalError.textContent = msg; }
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }

  function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
})();
