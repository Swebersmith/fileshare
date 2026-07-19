(function () {
  const isDownloadPage = window.location.pathname.includes("download");

  if (isDownloadPage) {
    initDownloadPage();
  } else {
    initUploadPage();
  }

  // ==================== Upload Page ====================
  function initUploadPage() {
    const dropZone = document.getElementById("upload-area");
    const fileInput = document.getElementById("file-input");
    const fileName = document.getElementById("file-name");
    const uploadBtn = document.getElementById("upload-btn");
    const progress = document.getElementById("progress");
    const progressFill = document.getElementById("progress-fill");
    const progressText = document.getElementById("progress-text");
    const result = document.getElementById("result");
    const shareLink = document.getElementById("share-link");
    const copyBtn = document.getElementById("copy-btn");
    const copyMsg = document.getElementById("copy-msg");

    let selectedFile = null;

    dropZone.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("click", (e) => e.stopPropagation());

    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("drag-over");
    });

    dropZone.addEventListener("dragleave", () => {
      dropZone.classList.remove("drag-over");
    });

    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("drag-over");
      const files = e.dataTransfer.files;
      if (files.length > 0) setFile(files[0]);
    });

    fileInput.addEventListener("change", () => {
      if (fileInput.files.length > 0) setFile(fileInput.files[0]);
    });

    function setFile(file) {
      selectedFile = file;
      fileName.textContent = file.name + " (" + formatSize(file.size) + ")";
      uploadBtn.disabled = false;
      result.classList.add("hidden");
      progress.classList.add("hidden");
    }

    uploadBtn.addEventListener("click", () => {
      if (!selectedFile) return;
      uploadFile(selectedFile);
    });

    copyBtn.addEventListener("click", () => {
      shareLink.select();
      document.execCommand("copy");
      navigator.clipboard?.writeText(shareLink.value);
      copyMsg.classList.remove("hidden");
      setTimeout(() => copyMsg.classList.add("hidden"), 3000);
    });

    function uploadFile(file) {
      uploadBtn.disabled = true;
      progress.classList.remove("hidden");

      const formData = new FormData();
      formData.append("file", file);
      formData.append("expiry", document.getElementById("expiry").value);
      formData.append("password", document.getElementById("password").value);

      const xhr = new XMLHttpRequest();

      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          progressFill.style.width = pct + "%";
          progressText.textContent = pct + "%";
        }
      });

      xhr.addEventListener("load", () => {
        if (xhr.status === 200) {
          const data = JSON.parse(xhr.responseText);
          progress.classList.add("hidden");
          result.classList.remove("hidden");
          const base = window.location.origin + window.location.pathname.replace("index.html", "");
          shareLink.value = base + "download?id=" + data.id;
          if (data.password) {
            shareLink.value += " (密码: " + data.password + ")";
          }
        } else {
          try {
            const err = JSON.parse(xhr.responseText);
            alert("上传失败: " + (err.error || "未知错误"));
          } catch (_) {
            alert("上传失败: HTTP " + xhr.status);
          }
        }
        uploadBtn.disabled = false;
      });

      xhr.addEventListener("error", () => {
        alert("上传失败: 网络错误");
        uploadBtn.disabled = false;
      });

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

    if (!fileId) {
      showError("缺少文件 ID");
      return;
    }

    let fileData = null;
    let downloadToken = null;

    fetch("/api/files/" + encodeURIComponent(fileId))
      .then((r) => r.json())
      .then((data) => {
        loading.classList.add("hidden");
        if (data.error) {
          showError(data.error);
          return;
        }
        fileData = data;
        detailName.textContent = data.name;
        detailSize.textContent = formatSize(data.size);
        fileInfo.classList.remove("hidden");

        if (data.hasPassword) {
          passwordSection.classList.remove("hidden");
        } else {
          downloadBtn.classList.remove("hidden");
        }
      })
      .catch(() => {
        loading.classList.add("hidden");
        showError("加载文件信息失败");
      });

    verifyBtn.addEventListener("click", () => {
      const pw = dlPassword.value.trim();
      if (!pw) return;
      passwordError.classList.add("hidden");

      fetch("/api/files/" + encodeURIComponent(fileId) + "/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.error) {
            passwordError.textContent = data.error;
            passwordError.classList.remove("hidden");
            return;
          }
          downloadToken = data.token;
          passwordSection.classList.add("hidden");
          downloadBtn.classList.remove("hidden");
        });
    });

    downloadBtn.addEventListener("click", () => {
      let url = "/api/download/" + encodeURIComponent(fileId);
      if (downloadToken) {
        url += "?token=" + encodeURIComponent(downloadToken);
      }
      const a = document.createElement("a");
      a.href = url;
      a.download = fileData?.name || "";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });

    function showError(msg) {
      loading.classList.add("hidden");
      errorSection.classList.remove("hidden");
      globalError.textContent = msg;
    }
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }
})();
