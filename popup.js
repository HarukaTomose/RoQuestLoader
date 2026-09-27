document.getElementById('startBtn').addEventListener('click', async () => {
  const startBtn = document.getElementById('startBtn');
  const statusText = document.getElementById('status');
  
  // ボタンを非表示にする
  startBtn.style.display = 'none';

  let allCsvRows = [];
  allCsvRows.push(['キャラクター名', 'クエスト名', '達成状況']);

  statusText.textContent = '初期チェック中...';

  try {
    // 1. ボタンを押した瞬間の現在のタブを取得
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab || !activeTab.url) {
      statusText.textContent = 'エラー: 有効なタブが見つかりません。';
      startBtn.style.display = 'block';
      return;
    }

    // URLの形式チェック（例: https://gungho.jp）
    const urlPattern = /^https:\/\/rowebtool\.gungho\.jp\/quest\/(\d+)\/(\d+)/;
    const match = activeTab.url.match(urlPattern);

    if (!match) {
      statusText.textContent = 'エラー: ROのクエスト情報ページ（.../quest/mm/nn）を開いた状態で実行してください。';
      startBtn.style.display = 'block';
      return;
    }

    const mm = match[1]; // URLから mm 部分（カテゴリID）を自動取得
    const baseUrl = `https://rowebtool.gungho.jp/quest/`+mm+`/`;

    statusText.textContent = '登録されているキャラクターを調査中...';

    // ==========================================
    // 【改善：ステップ1】外側から最も安全にHTMLテキストを取得する
    // ==========================================
    const [{ result: fullHtml }] = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      func: () => document.documentElement.outerHTML // ページ内のスクリプトはこれ1行だけ（HTMLを外に引き出すだけ）
    });

    if (!fullHtml) {
      statusText.textContent = 'エラー: ページのHTMLデータを取得できませんでした。';
      startBtn.style.display = 'block';
      return;
    }

    // 拡張機能側（ポップアップ内）の安全な環境で、正規表現を使ってリンクと名前を抽出する
    let activeCharacterMap = {};
    // マッチさせる正規表現（例: href="/quest/14/0" 形式のaタグと中身のテキスト）
    const linkRegex = new RegExp(`href=["']\\/quest\\/${mm}\\/(\\d+)["'][^>]*>([^<]+)<\\/a>`, 'gi');
    let regexMatch;

    while ((regexMatch = linkRegex.exec(fullHtml)) !== null) {
      const idNum = parseInt(regexMatch[1], 10);
      const name = regexMatch[2].trim();
      if (!isNaN(idNum) && name) {
        activeCharacterMap[idNum] = name;
      }
    }

    // 存在するID（数字）だけの配列を作成
    const activeIdList = Object.keys(activeCharacterMap).map(Number).sort((a, b) => a - b);

    // キャラクターが一人も見つからなかった場合の安全対策
    if (activeIdList.length === 0) {
      statusText.textContent = 'エラー: 登録されているキャラクターのリンクが見つかりませんでした。他キャラへのリンクが見えるページで実行してください。';
      startBtn.style.display = 'block';
      return;
    }

    statusText.textContent = `確認完了: ${activeIdList.length}人のキャラクターを順番にスキャンします...`;
    await new Promise(resolve => setTimeout(resolve, 1500));

    // ==========================================
    // 【ステップ2】存在するIDのリストだけをループ処理する
    // ==========================================
    for (let i = 0; i < activeIdList.length; i++) {
      const currentNum = activeIdList[i]; 
      const characterName = activeCharacterMap[currentNum]; 

      const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!currentTab) {
        statusText.textContent = 'エラー: タブの取得に失敗しました。';
        break;
      }

      const targetUrl = `${baseUrl}${currentNum}`;
      statusText.innerHTML = `[${i + 1}/${activeIdList.length}人目: ${characterName}] 移動中...<br><br><b>アクセス先:</b><br><span style="color:#0078d4; word-break:break-all;">${targetUrl}</span>`;
      
      // タブのURLを更新して移動
      await chrome.tabs.update(currentTab.id, { url: targetUrl });

      // ページの読み込み完了まで最大10秒待機
      await new Promise((resolve) => {
        let attempts = 0;
        const checkTab = async () => {
          attempts++;
          const tabInfo = await chrome.tabs.get(currentTab.id);
          if (tabInfo.status === 'complete' || attempts > 20) {
            resolve();
          } else {
            setTimeout(checkTab, 500);
          }
        };
        checkTab();
      });

      // サーバー負荷軽減（3秒）
      statusText.innerHTML = `[${i + 1}/${activeIdList.length}人目] 読み込み完了。<br>データ解析を待機中...`;
      await new Promise(resolve => setTimeout(resolve, 3000));

      // 💡 移動後のページでも、HTMLをそのまま引き出して拡張機能側でパース（解析）する方式にします
      statusText.innerHTML = `[${i + 1}/${activeIdList.length}人目] データを解析中...`;
      
      const [{ result: pageHtml }] = await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        func: () => document.documentElement.outerHTML
      });

      if (pageHtml) {
        // ポップアップ側の仮想環境でHTMLをパースする（安全かつ確実）
        const parser = new DOMParser();
        const doc = parser.parseFromString(pageHtml, 'text/html');
        const questItems = doc.querySelectorAll('ul.questList li');

        questItems.forEach(li => {
          const questName = li.textContent.trim();
          const isFinished = li.classList.contains('finished') ? '完了' : '未完了';
          allCsvRows.push([
            `"${characterName.replace(/"/g, '""')}"`, 
            `"${questName.replace(/"/g, '""')}"`,
            `"${isFinished.replace(/"/g, '""')}"`
          ]);
        });
      }
    }

    // ==========================================
    // CSVファイルの生成と保存
    // ==========================================
    statusText.textContent = 'CSVファイルを生成中...';

    const csvContent = '\uFEFF' + allCsvRows.map(e => e.join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    
    const reader = new FileReader();
    reader.onload = function(e) {
      chrome.downloads.download({
        url: e.target.result,
        filename: 'ro_quest_all_characters.csv',
        saveAs: false
      }, () => {
        statusText.textContent = '🎉 対象キャラクター全員分のCSV保存が完了しました！';
        startBtn.textContent = 'もう一度解析・保存する';
        startBtn.style.display = 'block';
      });
    };
    reader.readAsDataURL(blob);

  } catch (error) {
    console.error(error);
    statusText.textContent = `エラーが発生しました: ${error.message}`;
    startBtn.textContent = '再試行する';
    startBtn.style.display = 'block';
  }
});
