using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Automation;
using Minutas.Desktop.Models;

namespace Minutas.Desktop.Services;

public sealed class TeamsCaptionWatcher
{
    private static readonly Regex SpeakerLine = new(@"^(?<name>[^,;:!?()]{2,90})\s+\((?<org>[^)]+)\)$", RegexOptions.Compiled);

    // Ventana inicial (desde startedAt) durante la cual TODO chunk visible se aprende como chrome:
    // al arrancar la captura los subtítulos aún no existen, así que lo presente es UI estática.
    private const double ChromeBaselineWindowSeconds = 3.0;

    // Un chunk presente de forma continua >= este umbral es UI estática pegada (menú abierto,
    // roster, etiqueta del tile del hablante). Los subtítulos reales scrollean y desaparecen
    // mucho antes, así que nunca alcanzan este umbral.
    private const double ChromePersistenceThresholdSeconds = 15.0;

    // Blocklist residual: SOLO avisos transitorios del sistema que aparecen y desaparecen
    // demasiado rápido para que baseline/persistencia los aprendan, y que no son habla. Todo lo
    // demás (menús, toolbars, controles de subtítulos, roster) lo cubre ahora el ChromeSet
    // aprendido, de forma independiente de nombre/idioma/tenant. Un candidato es chrome si su
    // línea EMPIEZA con uno de estos prefijos (nunca un substring a mitad de frase).
    private static readonly string[] ChromeTransientNoticePrefixes =
    {
        "compartió pantalla", "compartio pantalla",
        "ha compartido pantalla", "shared their screen",
        "el zoom se restableció", "el zoom se restablecio", "zoom reset",
        "se ha iniciado el cierre del título", "se ha iniciado el cierre del titulo",
        "closed captions started",
    };

    // Caption text lives in Text/Document nodes; menu entries and toolbar/caption controls are
    // Buttons/MenuItems/ToolBars — reading their accessible Name as if it were speech is the bug.
    private static readonly Condition ChromeControlCondition = new OrCondition(
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button),
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuItem),
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ToolBar),
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.CheckBox));

    private readonly AppSettings _settings;
    private readonly Regex _windowTitleRegex;

    // Chrome aprendido por sesión de captura (una reunión). Textos de chunk normalizados
    // (Normalize: trim + colapso de espacios + lowercase invariante). Se resetea en WatchAsync.
    private readonly HashSet<string> _chromeSet = new(StringComparer.Ordinal);

    // Instante de la primera aparición CONTINUA de cada chunk normalizado. Un chunk que falta
    // en un poll se elimina (era transitorio) y su reloj se reinicia si vuelve a aparecer.
    private readonly Dictionary<string, DateTimeOffset> _chunkFirstSeen = new(StringComparer.Ordinal);

    public TeamsCaptionWatcher(AppSettings settings)
    {
        _settings = settings;
        _windowTitleRegex = new Regex(settings.WindowTitlePattern, RegexOptions.IgnoreCase | RegexOptions.Compiled);
    }

    public event EventHandler<CaptionObservation>? CaptionFinal;
    public event EventHandler<string>? StatusChanged;

    internal IReadOnlyList<AutomationElement> GetActiveTeamsWindows()
    {
        return GetTopLevelTeamsWindows(GetTeamsProcessIds()).ToArray();
    }

    internal bool AreCaptionsVisible()
    {
        return GetActiveCaptionRoots(GetTeamsProcessIds()).Count > 0;
    }

    /// <summary>True cuando el renderer expone los subtitulos como nodos UIA discretos.</summary>
    public bool HasStructuralCaptions()
    {
        return GetActiveCaptionRoots(GetTeamsProcessIds()).Any(root => root.StructuralCaptions.Count > 0);
    }

    public string? GetCurrentMeetingTitle()
    {
        return GetStatus().Title;
    }

    public TeamsMeetingStatus GetStatus()
    {
        var roots = GetActiveCaptionRoots(GetTeamsProcessIds()).ToArray();
        var title = roots
            .SelectMany(root => new[] { root.RootName, root.WindowName })
            .Select(CleanMeetingTitle)
            .FirstOrDefault(value => !string.IsNullOrWhiteSpace(value));

        return new TeamsMeetingStatus(
            MeetingActive: roots.Any(root => root.IsMeetingSurface && !root.MeetingEnded),
            CaptionsActive: roots.Any(root => root.HasCaptions || root.CaptionsUiVisible),
            CaptionsWindowActive: roots.Any(root => root.IsCaptionsWindow && root.HasCaptions),
            MeetingEnded: roots.Any(root => root.MeetingEnded),
            Title: title);
    }

    public async Task WatchAsync(DateTimeOffset startedAt, CancellationToken cancellationToken)
    {
        CaptionObservation? pending = null;
        DateTimeOffset? pendingChangedAt = null;
        var previousSnapshot = Array.Empty<CaptionObservation>();
        var initialSnapshotSeeded = false;
        var lastStatusAt = DateTimeOffset.MinValue;

        _chromeSet.Clear();
        _chunkFirstSeen.Clear();

        while (!cancellationToken.IsCancellationRequested)
        {
            var now = DateTimeOffset.UtcNow;
            var elapsed = (now - startedAt).TotalSeconds;
            var snapshot = ReadSnapshot(elapsed, now).ToArray();

            if (snapshot.Length > 0)
            {
                if (!initialSnapshotSeeded)
                {
                    previousSnapshot = snapshot;
                    initialSnapshotSeeded = true;
                }
                else
                {
                    foreach (var item in GetNewSnapshotItems(previousSnapshot, snapshot))
                    {
                        SubmitObservation(item, now, ref pending, ref pendingChangedAt);
                    }

                    previousSnapshot = snapshot;
                }
            }
            else if (now - lastStatusAt >= TimeSpan.FromSeconds(10))
            {
                StatusChanged?.Invoke(this, "Esperando subtitulos de Teams...");
                lastStatusAt = now;
            }

            PublishIfStable(now, ref pending, ref pendingChangedAt);
            await Task.Delay(_settings.CaptionPollInterval, cancellationToken).ConfigureAwait(false);
        }

        PublishPending(ref pending, ref pendingChangedAt);
    }

    private IEnumerable<CaptionObservation> ReadSnapshot(double elapsedSeconds, DateTimeOffset now)
    {
        var teamsProcessIds = GetTeamsProcessIds();
        var roots = GetActiveCaptionRoots(teamsProcessIds);

        LearnChrome(roots.SelectMany(root => GetChunks(root.PatternText)), elapsedSeconds, now);

        foreach (var root in roots)
        {
            // Camino preferido: el renderer expone cada subtitulo como nodos UIA discretos
            // (autor + texto). No necesita chrome learning ni parseo del blob plano, y es
            // independiente de nombre, organizacion, idioma y tenant.
            if (root.StructuralCaptions.Count > 0)
            {
                foreach (var caption in root.StructuralCaptions)
                {
                    yield return new CaptionObservation(
                        Math.Round(elapsedSeconds, 3),
                        caption.Speaker,
                        caption.Text,
                        root.IsOffscreen,
                        root.RootName);
                }

                continue;
            }

            var chromeControlNames = GetChromeControlNames(root.Element);
            foreach (var caption in ConvertCandidatesToCaptions(GetCaptionCandidates(root.PatternText), chromeControlNames, _chromeSet))
            {
                yield return new CaptionObservation(
                    Math.Round(elapsedSeconds, 3),
                    caption.Speaker,
                    caption.Text,
                    root.IsOffscreen,
                    root.RootName);
            }
        }
    }

    // Con el AXMode completo del renderer, el panel de subtitulos aparece como:
    //   Group  <contenedor>
    //     Group            <- lista
    //       Group          <- un enunciado
    //         Text  autor
    //         Group badge  (opcional: "Desconocido externo")
    //         Text  texto
    //     Button aid=closed-captions-pop-out-button
    //     Button aid=captions-panel-dismiss-button
    //     Button aid=captions-settings-menu-trigger-button-non-overflow
    // Los nodos de subtitulo tienen AutomationId vacio, pero los botones hermanos NO: ese
    // AutomationId es el ancla estable (no depende de idioma ni de tenant). Si el renderer no
    // esta en AXMode completo no hay nodos y devolvemos vacio -> el llamador cae al parser plano.
    private static IReadOnlyList<CaptionDraft> GetStructuralCaptions(AutomationElement root)
    {
        var buttons = Safe(
            () => root.FindAll(
                TreeScope.Descendants,
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button))
                .Cast<AutomationElement>().ToArray(),
            Array.Empty<AutomationElement>());

        foreach (var button in buttons)
        {
            var automationId = Safe(() => button.Current.AutomationId, "");
            if (automationId.IndexOf("captions", StringComparison.OrdinalIgnoreCase) < 0)
            {
                continue;
            }

            // El padre se busca en la MISMA vista que usa FindAll (control), no en la cruda: en la
            // vista cruda los Text del subtitulo no son hijos directos del item, y mezclarlas hacia
            // que el lector devolviera vacio con los nodos delante. Raw queda solo como respaldo.
            foreach (var container in new[]
                     {
                         Safe(() => TreeWalker.ControlViewWalker.GetParent(button), null),
                         Safe(() => TreeWalker.RawViewWalker.GetParent(button), null),
                     })
            {
                if (container is null)
                {
                    continue;
                }

                var captions = ExtractCaptionItems(container);
                if (captions.Count > 0)
                {
                    return captions;
                }
            }
        }

        return Array.Empty<CaptionDraft>();
    }

    private static IReadOnlyList<CaptionDraft> ExtractCaptionItems(AutomationElement container)
    {
        var groups = Safe(
            () => container.FindAll(
                TreeScope.Descendants,
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Group))
                .Cast<AutomationElement>().ToArray(),
            Array.Empty<AutomationElement>());

        var items = new List<CaptionDraft>();
        foreach (var group in groups)
        {
            // Un enunciado es el unico Group con >= 2 Text hijos directos (autor y texto).
            // El badge es un Group sin Text hijos, y la lista solo contiene Groups.
            var texts = GetTextChildren(group);
            if (texts.Length < 2)
            {
                continue;
            }

            items.Add(new CaptionDraft(texts[0], texts[^1]));
        }

        return items;
    }

    // FindAll(Children) recorre la misma vista del arbol que el resto de las busquedas.
    private static string[] GetTextChildren(AutomationElement element)
    {
        return Safe(
            () => element.FindAll(
                TreeScope.Children,
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text))
                .Cast<AutomationElement>()
                .Select(child => Safe(() => child.Current.Name, "").Trim())
                .Where(name => name.Length > 0)
                .ToArray(),
            Array.Empty<string>());
    }

    // Aprende dos señales dinámicas por poll, independientes de nombre/idioma/tenant:
    // (1) baseline: durante los primeros segundos todo chunk es UI estática;
    // (2) persistencia: un chunk continuo por mucho tiempo es UI pegada, no habla.
    private void LearnChrome(IEnumerable<string> chunks, double elapsedSeconds, DateTimeOffset now)
    {
        var present = new HashSet<string>(StringComparer.Ordinal);
        // Chunks que parsean como habla real: inmunes al ChromeSet (baseline y persistencia).
        // Un subtítulo que quede mucho tiempo en pantalla o que se diga en los primeros 3s
        // no debe aprenderse como chrome.
        var captions = new HashSet<string>(StringComparer.Ordinal);
        var inBaseline = elapsedSeconds < ChromeBaselineWindowSeconds;

        foreach (var chunk in chunks)
        {
            var normalized = Normalize(chunk);
            if (normalized.Length == 0)
            {
                continue;
            }

            present.Add(normalized);

            if (ParsesAsCaptionLine(chunk))
            {
                captions.Add(normalized);
                continue;
            }

            if (inBaseline)
            {
                _chromeSet.Add(normalized);
            }
        }

        foreach (var normalized in present)
        {
            if (captions.Contains(normalized))
            {
                continue;
            }

            if (!_chunkFirstSeen.TryGetValue(normalized, out var firstSeen))
            {
                firstSeen = now;
                _chunkFirstSeen[normalized] = firstSeen;
            }

            if ((now - firstSeen).TotalSeconds >= ChromePersistenceThresholdSeconds)
            {
                _chromeSet.Add(normalized);
            }
        }

        foreach (var stale in _chunkFirstSeen.Keys.Where(key => !present.Contains(key)).ToArray())
        {
            _chunkFirstSeen.Remove(stale);
        }
    }

    private static IEnumerable<string> GetChunks(string patternText)
    {
        return NormalizeText(patternText)
            .Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
    }

    private static string Normalize(string chunk)
    {
        return Regex.Replace(chunk.Trim(), @"\s+", " ").ToLowerInvariant();
    }

    private IReadOnlyList<CaptionRootSnapshot> GetActiveCaptionRoots(HashSet<int> teamsProcessIds)
    {
        var roots = new List<CaptionRootSnapshot>();

        foreach (var window in GetTopLevelTeamsWindows(teamsProcessIds))
        {
            var windowName = Safe(() => window.Current.Name, "");
            foreach (var rootWebArea in GetRootWebAreas(window))
            {
                var rootName = Safe(() => rootWebArea.Current.Name, "");
                if (IsTeamsChatSurfaceTitle(windowName) ||
                    IsTeamsChatSurfaceTitle(rootName))
                {
                    continue;
                }

                var isOffscreen = Safe<bool?>(() => rootWebArea.Current.IsOffscreen, null);
                var patternText = GetTextFromElement(rootWebArea);
                var isCaptionsWindow = IsCaptionsWindowTitle(windowName) || IsCaptionsWindowTitle(rootName);
                var isMeetingSurface = IsMeetingSurface(patternText);
                var structuralCaptions = GetStructuralCaptions(rootWebArea);
                // Los nodos estructurales tambien valen como senal de "hay subtitulos": asi el
                // root sobrevive aunque el blob plano no parsee (invitado sin "(Org)", otro idioma).
                var hasCaptions = structuralCaptions.Count > 0 || IsCaptionLikeText(patternText);
                var captionsUiVisible = ContainsCaptionChrome(patternText);
                var meetingEnded = IsMeetingEndedText(patternText);

                // Un root con subtitulos se conserva SIEMPRE, aunque IsMeetingSurface no puntue:
                // Teams auto-oculta la barra de controles con el mouse quieto y entonces el
                // patternText pierde "Salir"/"Compartir contenido" -> el score cae a 0 y se
                // descartaban subtitulos que seguian presentes en el arbol.
                if (!isMeetingSurface && !hasCaptions && !meetingEnded)
                {
                    continue;
                }

                var score = GetCaptionRootScore(rootName, windowName, patternText, isOffscreen, isCaptionsWindow);
                roots.Add(new CaptionRootSnapshot(rootWebArea, window, patternText, rootName, windowName, isOffscreen, score, isMeetingSurface, isCaptionsWindow, hasCaptions, captionsUiVisible, meetingEnded, structuralCaptions));
            }
        }
        return roots;
    }

    private static IEnumerable<CaptionDraft> ConvertCandidatesToCaptions(
        IEnumerable<string> candidates,
        IReadOnlySet<string>? chromeControlNames = null,
        IReadOnlySet<string>? chromeSet = null)
    {
        var currentSpeaker = "";

        foreach (var candidate in candidates)
        {
            // Chrome aprendido (baseline + persistencia): se descarta antes de parsear speaker/texto,
            // así nunca fija currentSpeaker ni se emite.
            if (chromeSet is not null && chromeSet.Contains(Normalize(candidate)))
            {
                continue;
            }

            if (IsCaptionUiLine(candidate))
            {
                continue;
            }

            if (IsBlockedChrome(candidate))
            {
                continue;
            }

            if (chromeControlNames is not null && chromeControlNames.Contains(candidate.Trim()))
            {
                continue;
            }

            var speakerMatch = SpeakerLine.Match(candidate);
            if (IsSpeakerLine(speakerMatch))
            {
                currentSpeaker = candidate.Trim();
                continue;
            }

            var parsed = ConvertToCaption(candidate);
            if (string.IsNullOrWhiteSpace(parsed.Text))
            {
                continue;
            }

            if (string.IsNullOrWhiteSpace(parsed.Speaker) && !string.IsNullOrWhiteSpace(currentSpeaker))
            {
                parsed = parsed with { Speaker = currentSpeaker };
            }

            yield return parsed;
        }
    }

    private static bool IsBlockedChrome(string line)
    {
        var value = line.Trim();
        if (value.Length == 0)
        {
            return false;
        }

        foreach (var prefix in ChromeTransientNoticePrefixes)
        {
            if (value.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    private static HashSet<string> GetChromeControlNames(AutomationElement root)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var controls = Safe(
            () => root.FindAll(TreeScope.Descendants, ChromeControlCondition).Cast<AutomationElement>().ToArray(),
            Array.Empty<AutomationElement>());

        foreach (var control in controls)
        {
            var name = Safe(() => control.Current.Name, "");
            if (!string.IsNullOrWhiteSpace(name))
            {
                names.Add(name.Trim());
            }
        }

        return names;
    }

    private static IEnumerable<string> GetCaptionCandidates(string patternText)
    {
        var lines = NormalizeText(patternText)
            .Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);

        var start = -1;
        var fallbackStart = -1;
        for (var i = 0; i < lines.Length; i++)
        {
            if (Regex.IsMatch(lines[i], "^(Invite people to join you|Live Captions)$"))
            {
                start = i;
            }

            if (fallbackStart < 0 && IsSpeakerLine(SpeakerLine.Match(lines[i])))
            {
                fallbackStart = i;
            }
        }

        if (start < 0)
        {
            if (fallbackStart < 0)
            {
                yield break;
            }

            start = fallbackStart - 1;
        }

        var end = lines.Length;
        for (var i = start + 1; i < lines.Length; i++)
        {
            if (Regex.IsMatch(lines[i], "Closed captions overflow menu|Hide live captions|More options|Calling controls", RegexOptions.IgnoreCase) ||
                IsTeamsChromeLine(lines[i]))
            {
                end = i;
                break;
            }
        }

        if (end <= start + 1)
        {
            yield break;
        }

        for (var i = start + 1; i < end; i++)
        {
            var line = lines[i];
            if (IsTeamsChromeLine(line))
            {
                continue;
            }

            if (Regex.IsMatch(line, "^(Settings and more|Calling indicators|Encryption status|Elapsed time|Meeting controls|Chat|People|Raise your hand|React|View|More|Turn camera|Open video|Open audio|Mute mic|Share content|Leave|Shared content view|Invite people to join you|Live Captions)$", RegexOptions.IgnoreCase))
            {
                continue;
            }

            if (Regex.IsMatch(line, @"^\d{1,2}:\d{2}$"))
            {
                continue;
            }

            yield return line;
        }
    }

    private static CaptionDraft ConvertToCaption(string line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return new CaptionDraft("", "");
        }

        var match = Regex.Match(line, @"^(?<speaker>.+?\([^)]+\))\s+(?<text>.+)$");
        return match.Success
            ? new CaptionDraft(match.Groups["speaker"].Value.Trim(), match.Groups["text"].Value.Trim())
            : new CaptionDraft("", line.Trim());
    }

    // Un chunk "parsea como subtítulo" si es una cabecera de hablante ("Nombre (Org)") o una
    // línea inline "Nombre (Org) texto" cuya porción de hablante pasa la misma detección
    // (IsSpeakerLine). Reutiliza el parser de captions; no duplica reglas de reconocimiento.
    private static bool ParsesAsCaptionLine(string chunk)
    {
        var line = chunk.Trim();
        if (line.Length == 0)
        {
            return false;
        }

        if (IsSpeakerLine(SpeakerLine.Match(line)))
        {
            return true;
        }

        var parsed = ConvertToCaption(line);
        return !string.IsNullOrWhiteSpace(parsed.Speaker) &&
            IsSpeakerLine(SpeakerLine.Match(parsed.Speaker));
    }

    private static bool IsSpeakerLine(Match match)
    {
        if (!match.Success)
        {
            return false;
        }

        var line = match.Value.Trim();
        if (IsTeamsChromeLine(line))
        {
            return false;
        }

        var name = match.Groups["name"].Value.Trim();
        var org = match.Groups["org"].Value.Trim();
        if (!name.Contains(' ', StringComparison.Ordinal) ||
            Regex.IsMatch(org, @"Ctrl|Alt|Shift|\+|You|more tabs|participants?", RegexOptions.IgnoreCase) ||
            Regex.IsMatch(name, @"^(Meeting with|Chat|Chats|New message|Teams|General|All Company|Shared|Join|See more|Type a message)", RegexOptions.IgnoreCase))
        {
            return false;
        }

        return true;
    }

    private static bool IsTeamsChromeLine(string line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return false;
        }

        return Regex.IsMatch(
                line,
                @"^(New message|Chats? \(|More filters|Copilot|Quick views|Mentions|Discover|Drafts|Favorites|Teams and channels|Chat participants|Shared$|[0-9]+ more tabs\.|Add a tab|Join$|View and add participants|Find in chat|Open chat details|More chat options|Type a message|See more|See all your teams|Communities|Join communities|Resize left panel|Meeting ended|Meeting started)",
                RegexOptions.IgnoreCase) ||
            Regex.IsMatch(
                line,
                @"^.+:\s*(joined the conversation\.|named the meeting|Chat has been turned on|Meeting ended:|[0-9]{1,2}:[0-9]{2}\s*(AM|PM).*(Meeting ended|Meeting started))",
                RegexOptions.IgnoreCase);
    }

    private static bool IsCaptionLikeText(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        return ConvertCandidatesToCaptions(GetCaptionCandidates(text))
            .Any(caption => !string.IsNullOrWhiteSpace(caption.Speaker) && !string.IsNullOrWhiteSpace(caption.Text));
    }

    private static bool IsCaptionUiLine(string line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return true;
        }

        return Regex.IsMatch(
            line,
            "^(Captions will be shown|Live Caption,|Closed captions|Hide live captions|Caption Settings|Open captions|Live captions language|Speaker attribution|Turn off live captions|Show captions|Subtitles|More options)",
            RegexOptions.IgnoreCase);
    }

    private void SubmitObservation(
        CaptionObservation caption,
        DateTimeOffset observedAt,
        ref CaptionObservation? pending,
        ref DateTimeOffset? pendingChangedAt)
    {
        if (string.IsNullOrWhiteSpace(caption.Text))
        {
            return;
        }

        if (pending is null)
        {
            SetPending(caption, observedAt, ref pending, ref pendingChangedAt);
            return;
        }

        var sameSpeaker = string.Equals(pending.Speaker, caption.Speaker, StringComparison.Ordinal);
        if (sameSpeaker && IsRevision(pending.Text, caption.Text))
        {
            if (ComparableText(caption.Text).Length > ComparableText(pending.Text).Length)
            {
                pending = pending with
                {
                    Text = caption.Text,
                    IsOffscreen = caption.IsOffscreen,
                    WindowName = caption.WindowName
                };
                pendingChangedAt = observedAt;
            }
            return;
        }

        if (sameSpeaker && IsRevision(caption.Text, pending.Text))
        {
            return;
        }

        PublishPending(ref pending, ref pendingChangedAt);
        SetPending(caption, observedAt, ref pending, ref pendingChangedAt);
    }

    private void PublishIfStable(
        DateTimeOffset now,
        ref CaptionObservation? pending,
        ref DateTimeOffset? pendingChangedAt)
    {
        if (pending is null || pendingChangedAt is null)
        {
            return;
        }

        if (now - pendingChangedAt >= _settings.CaptionStableDelay)
        {
            PublishPending(ref pending, ref pendingChangedAt);
        }
    }

    private void PublishPending(ref CaptionObservation? pending, ref DateTimeOffset? pendingChangedAt)
    {
        if (pending is null)
        {
            return;
        }

        CaptionFinal?.Invoke(this, pending);
        pending = null;
        pendingChangedAt = null;
    }

    private static void SetPending(
        CaptionObservation caption,
        DateTimeOffset observedAt,
        ref CaptionObservation? pending,
        ref DateTimeOffset? pendingChangedAt)
    {
        pending = caption;
        pendingChangedAt = observedAt;
    }

    private static IEnumerable<CaptionObservation> GetNewSnapshotItems(
        IReadOnlyList<CaptionObservation> previous,
        IReadOnlyList<CaptionObservation> current)
    {
        if (previous.Count == 0)
        {
            return current;
        }

        var previousKeys = previous
            .Select(item => $"{item.Speaker}|{item.Text}")
            .ToHashSet(StringComparer.Ordinal);
        var newItems = new List<CaptionObservation>();

        foreach (var item in current)
        {
            var key = $"{item.Speaker}|{item.Text}";
            if (!previousKeys.Contains(key))
            {
                newItems.Add(item);
            }
        }

        return newItems;
    }

    // El ASR de Teams REESCRIBE la linea en su lugar ("es no se" -> "es. No se"), no solo
    // agrega texto al final. Un test contra un dump real: el refinamiento de una misma frase
    // da similitud 0.93, mientras que enunciados DISTINTOS del mismo hablante no pasan de 0.31.
    // De ahi el umbral 0.6. El prefijo se mantiene porque cubre el crecimiento inicial
    // ("No se" -> "No se ni si tocan..."), donde la similitud es baja por diferencia de largo.
    private const double RevisionSimilarityThreshold = 0.6;

    private static bool IsRevision(string previousText, string currentText)
    {
        var previous = ComparableText(previousText);
        var current = ComparableText(currentText);
        if (previous.Length == 0)
        {
            return false;
        }

        if (current.Length >= previous.Length &&
            current.StartsWith(previous, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return Similarity(previous, current) >= RevisionSimilarityThreshold;
    }

    // Similitud normalizada por distancia de edicion (1 - dist/maxLen).
    private static double Similarity(string a, string b)
    {
        var x = a.ToLowerInvariant();
        var y = b.ToLowerInvariant();
        if (x.Length == 0 || y.Length == 0)
        {
            return 0;
        }

        var previousRow = new int[y.Length + 1];
        var currentRow = new int[y.Length + 1];
        for (var j = 0; j <= y.Length; j++)
        {
            previousRow[j] = j;
        }

        for (var i = 1; i <= x.Length; i++)
        {
            currentRow[0] = i;
            for (var j = 1; j <= y.Length; j++)
            {
                var cost = x[i - 1] == y[j - 1] ? 0 : 1;
                currentRow[j] = Math.Min(
                    Math.Min(currentRow[j - 1] + 1, previousRow[j] + 1),
                    previousRow[j - 1] + cost);
            }

            (previousRow, currentRow) = (currentRow, previousRow);
        }

        var distance = previousRow[y.Length];
        return 1.0 - ((double)distance / Math.Max(x.Length, y.Length));
    }

    private static string ComparableText(string text)
    {
        var value = Regex.Replace(text.Trim(), @"\s+", " ");
        return value.TrimEnd('.', ',', ';', ':', '?', '!', ' ');
    }

    private static string NormalizeText(string text)
    {
        return text
            .Replace('\ufffc', '\n')
            .Replace('\r', '\n')
            .Replace("|", "\n")
            .Replace("\t", " ");
    }

    private static bool IsMeetingEndedText(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        return Regex.IsMatch(
            NormalizeText(text),
            @"\b(Meeting ended|Call ended|Meeting has ended|The meeting has ended|You left the meeting|You've left the meeting|You have left the meeting|La reuni[oó]n termin[oó]|La llamada termin[oó]|Reuni[oó]n finalizada|Llamada finalizada|Saliste de la reuni[oó]n|Has salido de la reuni[oó]n|Te fuiste de la reuni[oó]n)\b",
            RegexOptions.IgnoreCase);
    }

    private static string GetTextFromElement(AutomationElement element)
    {
        var texts = new List<string>();

        var valuePattern = Safe(() => element.GetCurrentPattern(ValuePattern.Pattern), null);
        if (valuePattern is ValuePattern value && !string.IsNullOrWhiteSpace(value.Current.Value))
        {
            texts.Add(value.Current.Value.Trim());
        }

        var textPattern = Safe(() => element.GetCurrentPattern(TextPattern.Pattern), null);
        if (textPattern is TextPattern text)
        {
            var documentText = Safe(() => text.DocumentRange.GetText(20000), "");
            if (!string.IsNullOrWhiteSpace(documentText))
            {
                texts.Add(documentText.Replace('\uffff', ' ').Trim());
            }
        }

        return string.Join(" | ", texts.Distinct());
    }

    private IEnumerable<AutomationElement> GetTopLevelTeamsWindows(HashSet<int> teamsProcessIds)
    {
        var root = AutomationElement.RootElement;
        var windows = Safe(
            () => root.FindAll(TreeScope.Children, Condition.TrueCondition).Cast<AutomationElement>().ToArray(),
            Array.Empty<AutomationElement>());

        var candidates = new List<(AutomationElement Element, int Priority)>();
        var seenHandles = new HashSet<int>();
        foreach (var window in windows)
        {
            var processId = Safe(() => window.Current.ProcessId, 0);
            var name = Safe(() => window.Current.Name, "");
            var className = Safe(() => window.Current.ClassName, "");
            var automationId = Safe(() => window.Current.AutomationId, "");
            var handle = Safe(() => window.Current.NativeWindowHandle, 0);

            if (IsTeamsChatSurfaceTitle(name))
            {
                continue;
            }

            var titlePriority = GetTeamsWindowPriority(name);
            var priority = titlePriority >= 0
                ? titlePriority
                : teamsProcessIds.Contains(processId) ||
                    _windowTitleRegex.IsMatch(name) ||
                    (Regex.IsMatch(className, "Teams|MSTeams", RegexOptions.IgnoreCase) && !string.IsNullOrWhiteSpace(name)) ||
                    automationId.Contains("Teams", StringComparison.OrdinalIgnoreCase)
                        ? 1
                        : -1;

            if (priority >= 0)
            {
                if (handle != 0)
                {
                    seenHandles.Add(handle);
                }

                candidates.Add((window, priority));
            }
        }

        foreach (var handle in GetVisibleTeamsWindowHandles(teamsProcessIds))
        {
            if (!seenHandles.Add(handle.ToInt32()))
            {
                continue;
            }

            var element = Safe(() => AutomationElement.FromHandle(handle), null);
            if (element is not null)
            {
                var title = GetWindowText(handle);
                var titlePriority = GetTeamsWindowPriority(title);
                candidates.Add((element, titlePriority >= 0 ? titlePriority : 1));
            }
        }

        if (candidates.Count == 0)
        {
            yield break;
        }

        foreach (var candidate in candidates.OrderBy(candidate => candidate.Priority))
        {
            yield return candidate.Element;
        }
    }

    private static bool IsMeetingWindowName(string name)
    {
        return GetTeamsWindowPriority(name) >= 0;
    }

    private static int GetTeamsWindowPriority(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return -1;
        }

        if (IsTeamsChatSurfaceTitle(name))
        {
            return -1;
        }

        if (IsWebViewCallWindowTitle(name))
        {
            return 0;
        }

        if (IsTeamsAppSurfaceTitle(name))
        {
            return -1;
        }

        if (Regex.IsMatch(name, @"^(?!Chat \|).+\|\s*Microsoft Teams$", RegexOptions.IgnoreCase))
        {
            return 0;
        }

        if (Regex.IsMatch(name, @"Microsoft Teams Meeting|Reuni[oó]n|Llamada|Call", RegexOptions.IgnoreCase))
        {
            return 1;
        }

        if (Regex.IsMatch(name, @"^Chat \| .+\|\s*Microsoft Teams$|Meeting with", RegexOptions.IgnoreCase))
        {
            return 2;
        }

        if (IsCaptionsWindowTitle(name))
        {
            return 1;
        }

        return -1;
    }

    private static string? CleanMeetingTitle(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return null;
        }

        if (IsTeamsChatSurfaceTitle(name))
        {
            return null;
        }

        var value = NormalizeTeamsTitle(name);

        if (string.IsNullOrWhiteSpace(value) ||
            value.Equals("Microsoft Teams", StringComparison.OrdinalIgnoreCase) ||
            Regex.IsMatch(value, @"^(Subframe|Utility|Manager|GPU Process|Crashpad)\b", RegexOptions.IgnoreCase))
        {
            return null;
        }

        return value;
    }

    private static int GetCaptionRootScore(string rootName, string windowName, string patternText, bool? isOffscreen, bool isCaptionsWindow)
    {
        var score = 0;

        if (ContainsActiveMeetingChrome(patternText))
        {
            score -= 50;
        }

        if (ContainsCaptionChrome(patternText))
        {
            score -= 20;
        }

        if (isCaptionsWindow)
        {
            score -= 15;
        }

        if (IsTeamsChatSurfaceTitle(rootName) || IsTeamsChatSurfaceTitle(windowName))
        {
            score += 1000;
        }

        if (IsWebViewCallWindowTitle(rootName) || IsWebViewCallWindowTitle(windowName))
        {
            score -= 5;
        }

        if (isOffscreen == false)
        {
            score -= 2;
        }

        return score;
    }

    private static bool ContainsActiveMeetingChrome(string text)
    {
        return Regex.IsMatch(
            NormalizeText(text),
            @"\b(Share content|Compartir contenido|Leave|Salir|Abandonar|Raise your hand|Levantar la mano|Open audio options|Opciones de audio|Open video options|Opciones de video|Turn camera on|Activar c[aá]mara|Mute mic|Silenciar|People|Personas|Participants|Participantes|React|Reaccionar|Rooms|Salas|Notes|Notas)\b",
            RegexOptions.IgnoreCase);
    }

    private static bool IsMeetingSurface(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        var value = NormalizeText(text);
        var score = 0;

        if (Regex.IsMatch(value, @"\b(Leave|Salir|Abandonar|Colgar)\b", RegexOptions.IgnoreCase))
        {
            score += 3;
        }

        if (Regex.IsMatch(value, @"\b(Share content|Compartir contenido|Presentar)\b", RegexOptions.IgnoreCase))
        {
            score += 2;
        }

        if (Regex.IsMatch(value, @"\b(Raise your hand|Levantar la mano)\b", RegexOptions.IgnoreCase))
        {
            score += 2;
        }

        if (Regex.IsMatch(value, @"\b(Open audio options|Opciones de audio|Mute mic|Silenciar|Unmute|Reactivar audio)\b", RegexOptions.IgnoreCase))
        {
            score += 2;
        }

        if (Regex.IsMatch(value, @"\b(Open video options|Opciones de video|Turn camera on|Activar c[aá]mara|Camera|C[aá]mara)\b", RegexOptions.IgnoreCase))
        {
            score += 2;
        }

        if (Regex.IsMatch(value, @"\b(People|Personas|Participants|Participantes|React|Reaccionar|Rooms|Salas|Notes|Notas)\b", RegexOptions.IgnoreCase))
        {
            score += 1;
        }

        return score >= 5;
    }

    private static bool ContainsCaptionChrome(string text)
    {
        return Regex.IsMatch(
            text,
            @"\b(Live Captions|Closed captions|Hide live captions|Caption Settings|Open captions in new window|Turn off live captions|Show live captions|Captions will be shown|Subt[ií]tulos en vivo|Mostrar subt[ií]tulos en vivo)\b",
            RegexOptions.IgnoreCase);
    }

    private static bool IsTeamsAppSurfaceTitle(string name)
    {
        var value = NormalizeTeamsTitle(name);
        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        return Regex.IsMatch(
            value,
            @"^(Activity|Calendar|Chat|Chats|Teams|Calls|Files|OneDrive|Apps|Copilot|People|Meet|Search|Settings|Help|Assignments|Viva Engage|Runtime Broker|Microsoft Teams)$",
            RegexOptions.IgnoreCase);
    }

    private static bool IsTeamsChatSurfaceTitle(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return false;
        }

        var value = Regex.Replace(name.Trim(), @"^WebView2:\s*", "", RegexOptions.IgnoreCase);
        return Regex.IsMatch(value, @"^Chat\s*\|", RegexOptions.IgnoreCase);
    }

    private static bool IsCaptionsWindowTitle(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return false;
        }

        var value = Regex.Replace(name.Trim(), @"^WebView2:\s*", "", RegexOptions.IgnoreCase);
        return Regex.IsMatch(value, @"^(Captions|Subt[ií]tulos)\s*\|", RegexOptions.IgnoreCase);
    }

    private static bool IsWebViewCallWindowTitle(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return false;
        }

        if (IsTeamsChatSurfaceTitle(name))
        {
            return false;
        }

        if (!Regex.IsMatch(name, @"^WebView2:\s*.+\|\s*Microsoft Teams$", RegexOptions.IgnoreCase))
        {
            return false;
        }

        var value = NormalizeTeamsTitle(name);
        return !value.Equals("Microsoft Teams", StringComparison.OrdinalIgnoreCase) &&
            !Regex.IsMatch(value, @"^(Subframe|Utility|Manager|GPU Process|Crashpad)\b", RegexOptions.IgnoreCase);
    }

    private static string NormalizeTeamsTitle(string name)
    {
        var value = Regex.Replace(name.Trim(), @"^WebView2:\s*", "", RegexOptions.IgnoreCase);
        value = Regex.Replace(value, @"^Chat\s*\|\s*", "", RegexOptions.IgnoreCase);
        value = Regex.Replace(value, @"^(Captions|Subt[ií]tulos)\s*\|\s*", "", RegexOptions.IgnoreCase);
        value = Regex.Replace(value, @"\s*\|\s*Microsoft Teams$", "", RegexOptions.IgnoreCase);
        return value.Trim();
    }

    private IEnumerable<AutomationElement> GetRootWebAreas(AutomationElement window)
    {
        var condition = new PropertyCondition(AutomationElement.AutomationIdProperty, "RootWebArea");
        var areas = Safe(
            () => window.FindAll(TreeScope.Descendants, condition).Cast<AutomationElement>().ToArray(),
            Array.Empty<AutomationElement>());
        return areas;
    }

    private HashSet<int> GetTeamsProcessIds()
    {
        var ids = new HashSet<int>();

        foreach (var process in Process.GetProcesses())
        {
            try
            {
                if (Regex.IsMatch(process.ProcessName, "^(ms-teams|msteams|teams)$", RegexOptions.IgnoreCase) ||
                    process.MainWindowTitle.Contains("Teams", StringComparison.OrdinalIgnoreCase))
                {
                    ids.Add(process.Id);
                }
            }
            catch
            {
            }
        }

        return ids;
    }

    private IEnumerable<IntPtr> GetVisibleTeamsWindowHandles(HashSet<int> teamsProcessIds)
    {
        var handles = new List<IntPtr>();

        EnumWindows((hWnd, lParam) =>
        {
            GetWindowThreadProcessId(hWnd, out var windowProcessId);
            var title = GetWindowText(hWnd);
            var className = GetClassName(hWnd);
            var visible = IsWindowVisible(hWnd);

            if (IsTeamsChatSurfaceTitle(title))
            {
                return true;
            }

            if (!visible && !IsWebViewCallWindowTitle(title))
            {
                return true;
            }

            if (teamsProcessIds.Contains((int)windowProcessId) ||
                IsMeetingWindowName(title) ||
                _windowTitleRegex.IsMatch(title) ||
                (Regex.IsMatch(className, "Teams|MSTeams", RegexOptions.IgnoreCase) && !string.IsNullOrWhiteSpace(title)))
            {
                handles.Add(hWnd);
            }

            return true;
        }, IntPtr.Zero);

        return handles;
    }

    private static string GetWindowText(IntPtr hWnd)
    {
        var length = GetWindowTextLength(hWnd);
        if (length <= 0)
        {
            return "";
        }

        var builder = new StringBuilder(length + 1);
        _ = GetWindowText(hWnd, builder, builder.Capacity);
        return builder.ToString();
    }

    private static string GetClassName(IntPtr hWnd)
    {
        var builder = new StringBuilder(256);
        _ = GetClassName(hWnd, builder, builder.Capacity);
        return builder.ToString();
    }

    private static T Safe<T>(Func<T> fn, T fallback)
    {
        try
        {
            return fn();
        }
        catch
        {
            return fallback;
        }
    }

    private sealed record CaptionDraft(string Speaker, string Text);

    public sealed record TeamsMeetingStatus(
        bool MeetingActive,
        bool CaptionsActive,
        bool CaptionsWindowActive,
        bool MeetingEnded,
        string? Title)
    {
        public bool HasMeetingOrCaptions => MeetingActive || CaptionsActive || CaptionsWindowActive;
    }

    private sealed record CaptionRootSnapshot(
        AutomationElement Element,
        AutomationElement Window,
        string PatternText,
        string RootName,
        string WindowName,
        bool? IsOffscreen,
        int Score,
        bool IsMeetingSurface,
        bool IsCaptionsWindow,
        bool HasCaptions,
        bool CaptionsUiVisible,
        bool MeetingEnded,
        IReadOnlyList<CaptionDraft> StructuralCaptions);

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
