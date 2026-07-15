(function() {
  'use strict';

  // ============================================================
  //  0.  DEPENDENCIES: load marked + DOMPurify from CDN
  // ============================================================

  function ensureDependencies(callback) {
    var deps = [
      {
        name: 'marked',
        check: function() { return typeof marked !== 'undefined' && typeof marked.parse === 'function'; },
        url: 'https://cdn.jsdelivr.net/npm/marked/lib/marked.umd.js',
        fallback: function() {
          window.marked = { parse: function(t) { return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); } };
        }
      },
      {
        name: 'DOMPurify',
        check: function() { return typeof window.DOMPurify !== 'undefined'; },
        url: 'https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js',
        fallback: function() {
          window.DOMPurify = { sanitize: function(html) { return html; } };
        }
      }
    ];

    var pending = deps.length;

    deps.forEach(function(dep) {
      if (dep.check()) {
        pending--;
        if (pending === 0) callback();
        return;
      }
      var script = document.createElement('script');
      script.src = dep.url;
      script.onload = function() {
        pending--;
        if (pending === 0) callback();
      };
      script.onerror = function() {
        console.error('gravi-tec-chat: failed to load ' + dep.name + ', using fallback');
        dep.fallback();
        pending--;
        if (pending === 0) callback();
      };
      document.head.appendChild(script);
    });
  }

  // ============================================================
  //  1.  WIDGET UI
  // ============================================================

  function createWidgetUI(popupMode) {
    var container = document.querySelector('.gt-chat-container');
    if (!container) return null;
	
	console.log("GT_WIDGET:", window.GT_WIDGET);
	console.log("popupMode:", popupMode);

    if (popupMode) {
      // Create floating button
      var btn = document.createElement('div');
      btn.id = 'gt-widget-btn';
      btn.innerHTML = '&#128172;';

      // Wrap the chat container in a positioned popup
      if (popupMode) {
		var popup = document.createElement('div');
		popup.id = 'gt-widget-popup';

		document.body.appendChild(popup);
		popup.appendChild(container);

		// create floating button here
	} else {
		container.classList.add('gt-full-page');
	}

      // Add close button to header
      var header = container.querySelector('.gt-chat-header');
      var closeBtn = document.createElement('span');
      closeBtn.className = 'gt-chat-close-btn';
      closeBtn.innerHTML = '&#10005;';
      closeBtn.setAttribute('aria-label', 'Chat schlie\u00DFen');
      closeBtn.onclick = function(e) {
        e.stopPropagation();
        popup.style.display = 'none';
        btn.style.display = 'flex';
      };
      header.appendChild(closeBtn);

      // Toggle on button click
      btn.onclick = function() {
        var hidden = popup.style.display === 'none' || popup.style.display === '';
        popup.style.display = hidden ? 'block' : 'none';
        btn.style.display = hidden ? 'none' : 'flex';
        if (hidden) {
          var inp = document.getElementById('chatbot-input');
          if (inp) setTimeout(function() { inp.focus(); }, 300);
        }
      };

      document.body.appendChild(btn);
    } else {
      // Full-page mode: render inline without button/popup/close
      container.classList.add('gt-full-page');
      container.style.display = 'flex';
    }

    return container;
  }

  // ============================================================
  //  2.  CONFIG
  // ============================================================

  function initChat() {
    const popupMode = !!Number(window.GT_WIDGET?.popupMode);

    // Create widget UI (button + popup wrapping or full-page)
    var chatContainer = createWidgetUI(popupMode);
    if (!chatContainer) {
      console.error('gravi-tec-chat: .gt-chat-container not found');
      return;
    }

    // ============================================================
    //  3a.  CONFIG & STATE
    // ============================================================

    var IS_LOCAL = false;
    var sessionID = "test_session_" + formatDateNow() + "_" + Math.random().toString(36).substr(2, 9);
    var BASE_URL = IS_LOCAL
      ? "http://localhost:8000"
      : "https://avahai.gravi-tec.de";

    var backendURLstream = BASE_URL + "/api/v1/chat/stream";
    var backendCurrentOrderURL = BASE_URL + "/api/v1/sessions/current-order";
    var possibleResponsesURL = BASE_URL + "/api/v1/prompt/responses";

    var ENABLE_TOOL_STATUS_BAR = true;

    var messages = [];
    var isWaitingResponse = false;
    var typingIndicator = null;
    var greeted = false;
    var isOrderViewActive = false;
    var activeToolCalls = [];
    var toolStatusInterval = null;

    var sidEl = document.getElementById('session-id-value');
    if (sidEl) sidEl.textContent = sessionID;

    // ============================================================
    //  3b.  DOM REFERENCES
    // ============================================================

    var chat = document.getElementById('chat');
    var input = document.getElementById('chatbot-input');

    // --- response template ---
    var gtResponseTemplate = document.getElementById('gt-response-template');
    var gtResponseToggle   = document.getElementById('gt-response-toggle');
    var gtResponseList     = document.getElementById('gt-response-template-list');

    // ============================================================
    //  3c.  SSE STREAM HANDLER
    // ============================================================

    async function sendMessageStream() {
      if (isWaitingResponse) return;
      var hasStartedStreaming = false;
      var botInnerEl = null;
      var thinkingEl = null;

      var inputEl = document.querySelector('.gt-chat-input-field');
      var text = inputEl.value.trim();
      if (!text) return;

      isWaitingResponse = true;
      var sendBtn = document.getElementById('sendBtn');
      sendBtn.style.pointerEvents = 'none';
      sendBtn.style.opacity = '0.6';

      addMessage('user', text);
      inputEl.value = '';
      resetTextareaHeight();
      showTyping();

      try {
        var userMessage = {
          role: 'user',
          content: text,
          timestamp: Date.now()
        };

        var requestBody = {
          session_id: sessionID,
          message: userMessage
        };

        var res = await fetch(backendURLstream, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        });

        if (!res.body) throw new Error('Streaming not supported');

        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';

        while (true) {
          var result = await reader.read();
          if (result.done) break;

          buffer += decoder.decode(result.value, { stream: true });
          var parts = buffer.split('\n\n');
          buffer = parts.pop();

          for (var pi = 0; pi < parts.length; pi++) {
            var part = parts[pi];
            if (!part.startsWith('data:')) continue;

            var json;
            try {
              json = JSON.parse(part.replace('data:', '').trim());
            } catch (e) {
              console.warn('SSE: skipping malformed chunk', part);
              continue;
            }

            switch (json.type) {

              case 'token':
                if (!hasStartedStreaming) {
                  removeTyping();
                  botInnerEl = addStreamingBotMessage();
                  hasStartedStreaming = true;
                }
                appendToBotMessage(botInnerEl, json.text);
                break;

              case 'thinking':
                if (!thinkingEl) {
                  thinkingEl = addThinkingIndicator();
                }
                appendToThinking(thinkingEl, json.content);
                break;

              case 'tool_call':
                activeToolCalls.push({ callId: json.tool_call_id, name: json.tool_name });
                showToolStatus(json.tool_name);
                break;

              case 'tool_result':
                var callId = json ? json.tool_call_id : null;
                if (callId) hideToolStatus(callId);
                break;

              case 'part_start':
                console.log('Starting part ' + json.index + ': ' + json.part_type);
                break;

              case 'final_result_start':
                if (thinkingEl) markThinkingComplete(thinkingEl);
                break;

              case 'user_options':
                if (botInnerEl) {
                  appendUserOptions(botInnerEl, json.options);
                }
                break;

              case 'final':
                if (botInnerEl) {
                  messages.push({
                    role: 'assistant',
                    content: botInnerEl._raw || json.output,
                    timestamp: Date.now()
                  });
                }
                break;

              case 'error':
                if (!botInnerEl) {
                  botInnerEl = addStreamingBotMessage();
                }
                appendToBotMessage(botInnerEl, '\n\n\u26A0\uFE0F ' + json.detail);
                break;
            }

            if (json.error) {
              if (!botInnerEl) {
                botInnerEl = addStreamingBotMessage();
              }
              appendToBotMessage(botInnerEl, '\n\n\u26A0\uFE0F ' + json.message);
            }
          }
        }
      } catch (e) {
        console.error(e);
        if (!botInnerEl) botInnerEl = addStreamingBotMessage();
        appendToBotMessage(botInnerEl, '\n\n\u274C Verbindung zum Server fehlgeschlagen.');
      } finally {
        isWaitingResponse = false;
        removeTyping();
        clearToolStatusBar();
        sendBtn.style.pointerEvents = 'auto';
        sendBtn.style.opacity = '1';
      }
    }

    // ============================================================
    //  3d.  MESSAGE RENDERERS
    // ============================================================

    function addMessage(role, content) {
      messages.push({ role: role, content: content, timestamp: Date.now() });

      var frag = document.getElementById('tpl-message-row').content.cloneNode(true);
      frag.querySelector('.gt-chat-message-row').classList.add(role);
      frag.querySelector('.gt-chat-message').classList.add(role);

      var formattedContent = content
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '&nbsp;&nbsp;')
        .replace(/\\ /g, ' ')
        .replace(/\n/g, '<br>');

      frag.querySelector('span').innerHTML = sanitizeMarkdown(formattedContent);
      chat.appendChild(frag);
    }

    function showTyping() {
      var frag = document.getElementById('tpl-typing').content.cloneNode(true);
      typingIndicator = frag.querySelector('.gt-chat-typing');
      chat.appendChild(frag);
    }

    function removeTyping() {
      if (typingIndicator) {
        chat.removeChild(typingIndicator);
        typingIndicator = null;
      }
    }

    function addStreamingBotMessage() {
      var frag = document.getElementById('tpl-message-row').content.cloneNode(true);
      frag.querySelector('.gt-chat-message-row').classList.add('assistant');
      frag.querySelector('.gt-chat-message').classList.add('assistant');
      var inner = frag.querySelector('span');
      chat.appendChild(frag);
      return inner;
    }

    function appendToBotMessage(innerEl, textChunk) {
      if (!innerEl) return;
      innerEl._raw = (innerEl._raw || '') + textChunk;
      innerEl.innerHTML = sanitizeMarkdown(innerEl._raw);
    }

    // ============================================================
    //  3e.  THINKING INDICATOR
    // ============================================================

    function addThinkingIndicator() {
      var frag = document.getElementById('tpl-thinking').content.cloneNode(true);
      var thinkingDiv = frag.querySelector('.gt-thinking-indicator');
      chat.appendChild(frag);
      return thinkingDiv;
    }

    function appendToThinking(thinkingEl, text) {
      var contentEl = thinkingEl.querySelector('.gt-thinking-content');
      if (contentEl) {
        contentEl.textContent += text;
      }
    }

    function markThinkingComplete(thinkingEl) {
      if (!thinkingEl) return;
      thinkingEl.classList.add('gt-complete');
      var label = thinkingEl.querySelector('.gt-thinking-label');
      if (label) {
        label.textContent = 'Denken abgeschlossen';
      }
    }

    function removeThinkingIndicator(thinkingEl) {
      if (!thinkingEl || !thinkingEl.parentNode) return;
      thinkingEl.classList.add('gt-faded');
    }

    // ============================================================
    //  3f.  TOOL STATUS BAR
    // ============================================================

    function showToolStatus(name) {
      if (!ENABLE_TOOL_STATUS_BAR) return;
      var bar = document.getElementById('gtToolStatusBar');
      var nameEl = document.getElementById('gtToolStatusName');
      var dotsEl = document.getElementById('gtToolStatusDots');
      if (!bar || !nameEl || !dotsEl) return;
      nameEl.textContent = name;
      bar.style.display = 'flex';
      if (toolStatusInterval) clearInterval(toolStatusInterval);
      var step = 0;
      toolStatusInterval = setInterval(function() {
        step = (step % 3) + 1;
        dotsEl.textContent = Array(step + 1).join('\u00B7');
      }, 400);
    }

    function hideToolStatus(callId) {
      if (!ENABLE_TOOL_STATUS_BAR) return;
      activeToolCalls = activeToolCalls.filter(function(c) { return c.callId !== callId; });
      var bar = document.getElementById('gtToolStatusBar');
      if (activeToolCalls.length > 0) {
        showToolStatus(activeToolCalls[activeToolCalls.length - 1].name);
      } else {
        if (toolStatusInterval) {
          clearInterval(toolStatusInterval);
          toolStatusInterval = null;
        }
        if (bar) bar.style.display = 'none';
      }
    }

    function clearToolStatusBar() {
      if (toolStatusInterval) {
        clearInterval(toolStatusInterval);
        toolStatusInterval = null;
      }
      activeToolCalls = [];
      var bar = document.getElementById('gtToolStatusBar');
      if (bar) bar.style.display = 'none';
    }

    // ============================================================
    //  3g.  USER OPTIONS
    // ============================================================

    function appendUserOptions(innerEl, options) {
      if (!innerEl) return;

      var parentMsg = innerEl.parentNode;
      var container = parentMsg.querySelector('.gt-answer-options');

      if (!options || !options.length) {
        if (container) container.style.display = 'none';
        return;
      }

      if (!container) {
        var frag = document.getElementById('tpl-answer-options').content.cloneNode(true);
        container = frag.querySelector('.gt-answer-options');
        parentMsg.appendChild(frag);
      }
      container.style.display = '';

      options.forEach(function(opt) {
        var alreadyExists = Array.from(container.querySelectorAll('.gt-answer-option-btn'))
          .some(function(b) { return b.textContent === opt; });
        if (alreadyExists) return;
        var btn = document.createElement('button');
        btn.className = 'gt-answer-option-btn';
        btn.textContent = opt;
        btn.addEventListener('click', function() {
          var inp = document.getElementById('chatbot-input');
          inp.value = opt;
          sendMessageStream();
        });
        container.appendChild(btn);
      });
    }

    // ============================================================
    //  3h.  RESPONSE TEMPLATES
    // ============================================================

    if (gtResponseToggle && gtResponseTemplate) {
      gtResponseToggle.addEventListener('click', function() {
        gtResponseTemplate.classList.toggle('active');
      });

      document.addEventListener('click', function(e) {
        var inside = gtResponseTemplate.contains(e.target) || gtResponseToggle.contains(e.target);
        if (!inside) {
          gtResponseTemplate.classList.remove('active');
        }
      });
    }

    async function loadPossibleResponses() {
      try {
        var res = await fetch(possibleResponsesURL);
        if (!res.ok) throw new Error('Failed to load responses');
        var data = await res.json();
        var items = data.responses || data;
        renderResponses(items);
      } catch (err) {
        console.error('Response load error:', err);
      }
    }

    function renderResponses(items) {
      if (!items) items = [];
      if (!gtResponseList) return;
      gtResponseList.innerHTML = '';
      items.forEach(function(text) {
        var frag = document.getElementById('tpl-response-btn').content.cloneNode(true);
        var btn = frag.querySelector('button');
        btn.textContent = text;
        btn.onclick = function() { copyToTextarea(text); };
        gtResponseList.appendChild(frag);
      });
    }

    loadPossibleResponses();

    // ============================================================
    //  3i.  COPY TO TEXTAREA
    // ============================================================

    function copyToTextarea(text) {
      var inp = document.getElementById('chatbot-input');
      if (!inp) return;
      if (inp.value.trim().length === 0) {
        inp.value = text;
      } else {
        inp.value += '\n' + text;
      }
      inp.focus();
      inp.dispatchEvent(new Event('input'));
    }

    // ============================================================
    //  3j.  INPUT HANDLING
    // ============================================================

    if (input) {
      input.addEventListener('keydown', function(e) {
        if (document.activeElement !== input) return;
        if (isWaitingResponse) return;
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessageStream();
        }
      });

      input.addEventListener('input', function() {
        input.style.height = 'auto';
        var lineH = parseInt(getComputedStyle(input).lineHeight, 10);
        var maxH = lineH * 5 + 24;
        input.style.height = Math.min(input.scrollHeight, maxH) + 'px';
      });
    }

    function resetTextareaHeight() {
      if (!input) return;
      input.style.height = 'auto';
      var lineH = parseInt(getComputedStyle(input).lineHeight, 10);
      input.style.height = lineH + 12 + 'px';
    }

    // ============================================================
    //  3k.  ORDER VIEW
    // ============================================================

    async function toggleOrderView() {
      var chatView = document.getElementById('chat');
      var orderView = document.getElementById('orderView');
      var toggleBtn = document.getElementById('toggleOrderBtn');
      var orderLoading = document.getElementById('orderLoading');
      var orderContent = document.getElementById('orderContent');
      var inputWrapper = document.querySelector('.gt-chat-textarea-wrapper');
      var sendBtn = document.getElementById('sendBtn');

      isOrderViewActive = !isOrderViewActive;

      if (isOrderViewActive) {
        chatView.style.display = 'none';
        orderView.style.display = 'block';
        toggleBtn.querySelector('.gt-order-toggle-text').textContent = '\uD83D\uDCAC';

        orderLoading.style.display = 'flex';
        orderContent.innerHTML = '';

        try {
          var response = await fetch(backendCurrentOrderURL, {
            headers: { 'X-Session-Id': sessionID }
          });
          if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + response.statusText);
          var data = await response.json();

          if (!data || Object.keys(data).length === 0) {
            orderContent.innerHTML =
              '<div class="gt-order-empty">' +
                '\uD83D\uDCCB Keine Bestelldaten verf\u00FCgbar' +
              '</div>';
            return;
          }

          var html = '';

          if (data.status) {
            html += renderOrderStatusBanner(data.status);
          }

          if (data.status === 'no_orders') {
            orderContent.innerHTML = html;
            return;
          }

          if (data.herkunft) {
            html +=
              '<div class="gt-order-section">' +
                '<h3>Herkunft</h3>' +
                '<div class="gt-order-pills">' +
                  pill('Quelle', data.herkunft) +
                '</div>' +
              '</div>';
          }

          if (data.formular_daten) {
            var form = data.formular_daten;
            html +=
              '<div class="gt-order-section">' +
                '<h3>Bestelldaten</h3>' +
                '<div class="gt-order-pills">';

            if (form.anzahl)     html += pill('Anzahl', form.anzahl);
            if (form.schild_x)   html += pill('Breite', form.schild_x + ' mm');
            if (form.schild_y)   html += pill('H\u00F6he', form.schild_y + ' mm');
            if (form.schild_z)   html += pill('Tiefe', form.schild_z + ' mm');
            if (form.ver_part_d) html += pill('Durchmesser', form.ver_part_d + ' mm');

            if (form.produkt && form.produkt.name)                    html += pill('Produkt', form.produkt.name);
            if (form.produkt_kategorie && form.produkt_kategorie.name) html += pill('Produkt Kategorie', form.produkt_kategorie.name);
            if (form.material_kategorie && form.material_kategorie.name) html += pill('Material Kategorie', form.material_kategorie.name);
            if (form.material_unterkategorie && form.material_unterkategorie.name) html += pill('Material Unterkategorie', form.material_unterkategorie.name);
            if (form.material && form.material.name)                   html += pill('Material', form.material.name);

            html +=
                '</div>' +
              '</div>';

            html += renderCompactCollection('Veredelungen', form.veredelungen);
            html += renderCompactCollection('Addons', form.addons);
            html += renderCompactCollection('Handlungen', form.handlungen);

            orderContent.innerHTML = html;
          }
        } catch (err) {
          console.error(err);
          orderContent.innerHTML =
            '<div class="gt-order-error">' +
              '<strong>\u26A0\uFE0F Fehler beim Laden der Bestellung</strong>' +
              '<div>Fehler beim Laden der Bestellung. Bitte versuchen Sie es sp\u00e4ter erneut.</div>' +
            '</div>';
        } finally {
          orderLoading.style.display = 'none';
        }
      } else {
        chatView.style.display = 'block';
        orderView.style.display = 'none';
        toggleBtn.querySelector('.gt-order-toggle-text').textContent = '\uD83D\uDCE6';
      }
    }

    // ============================================================
    //  3l.  ORDER RENDERERS
    // ============================================================

    function pill(label, value) {
      return (
        '<div class="gt-order-pill">' +
          (label
            ? '<span class="gt-order-pill-label">' + escapeHtml(label) + ':</span>'
            : '') +
          '<span class="gt-order-pill-value">' + escapeHtml(String(value)) + '</span>' +
        '</div>'
      );
    }

    function renderOrderStatusBanner(status) {
      var icon, text, cls;
      switch (status) {
        case 'in_progress':
          icon = '\uD83D\uDEE0\uFE0F';
          text = 'Bestellung in Bearbeitung';
          cls = 'in-progress';
          break;
        case 'completed':
          icon = '\u2705';
          text = 'Bestellung abgeschlossen';
          cls = 'complete';
          break;
        case 'no_orders':
          icon = '\uD83D\uDCED';
          text = 'Noch keine Bestellung';
          cls = 'no-orders';
          break;
        default:
          return '';
      }
      return (
        '<div class="gt-order-status-banner ' + cls + '">' +
          '<span class="gt-status-icon">' + icon + '</span>' +
          '<span>' + text + '</span>' +
        '</div>'
      );
    }

    function expandablePill(name, details) {
      if (!details) details = {};
      var entries = Object.entries(details).filter(function(kv) {
        return kv[0] !== 'name' && kv[1] !== null && kv[1] !== undefined && kv[1] !== '';
      });
      var hasDetails = entries.length > 0;

      var html =
        '<div class="gt-order-pill-wrapper">' +
          '<div class="gt-order-pill' + (hasDetails ? ' expandable' : '') + '">' +
            '<span class="gt-order-pill-value">' + escapeHtml(String(name)) + '</span>' +
            (hasDetails ? '<span class="gt-order-pill-arrow">\u2193</span>' : '') +
          '</div>';

      if (hasDetails) {
        html += '<div class="gt-order-pill-dropdown">';
        entries.forEach(function(kv) {
          html +=
            '<div class="gt-order-pill-detail">' +
              '<span class="gt-order-pill-detail-label">' + escapeHtml(formatFieldName(kv[0])) + ':</span> ' +
              escapeHtml(String(kv[1])) +
            '</div>';
        });
        html += '</div>';
      }

      html += '</div>';
      return html;
    }

    function renderCompactCollection(title, items) {
      if (!items || !items.length) return '';
      var html =
        '<div class="gt-order-subsection-block">' +
          '<div class="gt-order-subsection-title">' + escapeHtml(title) + '</div>' +
          '<div class="gt-order-pills">';

      items.forEach(function(item, index) {
        var name = item.name || item.bezeichnung || item.titel || ('#' + (index + 1));
        html += expandablePill(name, item);
      });

      html +=
          '</div>' +
        '</div>';
      return html;
    }

    function renderMutedDetails(obj) {
      if (!obj) return '';
      var entries = Object.entries(obj).filter(function(kv) {
        return kv[0] !== 'name' && kv[1] !== null && kv[1] !== undefined && kv[1] !== '';
      });
      if (!entries.length) return '';

      var html =
        '<div class="gt-order-detail-card">' +
          '<div class="gt-order-detail-toggle">' +
            'Details anzeigen' +
          '</div>' +
          '<div class="gt-order-detail-content">';

      entries.forEach(function(kv) {
        html +=
          '<div class="gt-order-detail-row">' +
            '<span class="gt-order-detail-label">' + escapeHtml(formatFieldName(kv[0])) + ':</span> ' +
            escapeHtml(String(kv[1])) +
          '</div>';
      });

      html +=
          '</div>' +
        '</div>';
      return html;
    }

    function renderField(key, value) {
      if (value === null || value === undefined || value === '') return '';

      if (Array.isArray(value)) {
        if (value.length === 0) return '';
        if (typeof value[0] === 'object' && value[0] !== null) {
          var html = '<div class="gt-order-field"><span class="gt-order-field-label">' + formatFieldName(key) + '</span></div>';
          value.forEach(function(item, idx) {
            var name = item.name || item.id || ('#' + (idx + 1));
            html += '<div class="gt-order-array-item">';
            html += '<div class="gt-order-item-header">' + escapeHtml(String(name)) + '</div>';
            Object.entries(item).forEach(function(kv) {
              if (kv[0] === 'name' || kv[1] === null || kv[1] === undefined || kv[1] === '') return;
              html += '<div class="gt-order-field">';
              html += '<span class="gt-order-field-label">' + formatFieldName(kv[0]) + '</span>';
              html += '<span class="gt-order-field-value">' + formatValue(kv[1]) + '</span>';
              html += '</div>';
            });
            html += '</div>';
          });
          return html;
        } else {
          return (
            '<div class="gt-order-field">' +
              '<span class="gt-order-field-label">' + formatFieldName(key) + '</span>' +
              '<span class="gt-order-field-value">' + value.map(function(v) { return formatValue(v); }).join(', ') + '</span>' +
            '</div>'
          );
        }
      }

      if (typeof value === 'object' && value !== null) {
        var entries = Object.entries(value).filter(function(kv) {
          return kv[1] !== null && kv[1] !== undefined && kv[1] !== '';
        });
        if (entries.length === 1 && value.name) {
          return (
            '<div class="gt-order-field">' +
              '<span class="gt-order-field-label">' + formatFieldName(key) + '</span>' +
              '<span class="gt-order-field-value">' + formatValue(value.name) + '</span>' +
            '</div>'
          );
        }
        var html = '<div class="gt-order-array-item">';
        var name = value.name || formatFieldName(key);
        html += '<div class="gt-order-item-header">' + escapeHtml(String(name)) + '</div>';
        entries.forEach(function(kv) {
          if (kv[0] === 'name') return;
          html += '<div class="gt-order-field">';
          html += '<span class="gt-order-field-label">' + formatFieldName(kv[0]) + '</span>';
          html += '<span class="gt-order-field-value">' + formatValue(kv[1]) + '</span>';
          html += '</div>';
        });
        html += '</div>';
        return html;
      }

      return (
        '<div class="gt-order-field">' +
          '<span class="gt-order-field-label">' + formatFieldName(key) + '</span>' +
          '<span class="gt-order-field-value">' + formatValue(value) + '</span>' +
        '</div>'
      );
    }

    function formatValue(value) {
      if (typeof value === 'boolean') {
        return value ? '\u2713 Ja' : '\u2717 Nein';
      }
      return escapeHtml(String(value));
    }

    function formatFieldName(name) {
      return name.replace(/_/g, ' ').replace(/\b\w/g, function(l) { return l.toUpperCase(); });
    }

    // ============================================================
    //  3m.  UTILITIES
    // ============================================================

    function formatDateNow() {
      var d = new Date(Date.now());
      var pad = function(n) { return String(n).padStart(2, '0'); };
      return (
        d.getFullYear() + '_' +
        pad(d.getMonth() + 1) + '_' +
        pad(d.getDate()) + '_' +
        pad(d.getHours()) + '_' +
        pad(d.getMinutes()) + '_' +
        pad(d.getSeconds())
      );
    }

    function escapeHtml(text) {
      var div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function sanitizeMarkdown(text) {
      var html = marked.parse(text);
      return DOMPurify.sanitize(html);
    }

    function scrollToBottom() {
      var chatMessages = document.querySelector('.gt-chat-messages');
      if (chatMessages) {
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
    }

    // ============================================================
    //  INIT
    // ============================================================

    // Show greeting
    var greetingMessage = '👋 Willkommen bei Gravi-Tec!\n\nIch unterstütze Sie gerne bei:\n\n• 🏷️ Schildern und Gravuren – von Türschildern bis zu individuellen Gravuren auf ihren Teilen\n• ⚙️ Konfigurationen – Material, Größe, Ausführung und Zubehör passend auswählen\n• 💡 Beratung – die passende Gravurtechnik und Ausführung für Ihren Anwendungsfall finden\n• 💶 Preisen und Angeboten – Konfigurationen kalkulieren und Angebote vorbereiten\n• 📦 Bestellungen – bestehende Konfigurationen als Angebote per Email bekommen \n\nBeschreiben Sie einfach Ihr Vorhaben – ich begleite Sie Schritt für Schritt.';
    
	addMessage('assistant', greetingMessage);
    greeted = true;
    resetTextareaHeight();

    document.getElementById('sendBtn').addEventListener('click', function(e) {
      e.preventDefault();
      sendMessageStream();
    });
    document.getElementById('toggleOrderBtn').addEventListener('click', toggleOrderView);

    document.getElementById('orderContent').addEventListener('click', function(e) {
      var target = e.target.closest('.gt-order-pill.expandable');
      if (target) {
        target.parentNode.classList.toggle('open');
        return;
      }
      target = e.target.closest('.gt-order-detail-toggle');
      if (target) {
        target.parentNode.classList.toggle('open');
      }
    });
  }

  // ============================================================
  //  START
  // ============================================================

  function start() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function() {
        ensureDependencies(initChat);
      });
    } else {
      ensureDependencies(initChat);
    }
  }

  start();
})();
