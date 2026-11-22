/* =====================================================
   CFSI Student Portfolio - Supabase Backend Connection
   teams-integration v1
   ===================================================== */
const SUPABASE_URL = 'https://tgwmeyxtgdlljyrqfopb.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_KlBEnbQhLJB7_7q27FvrLg_Mt4HIL3X';
const BUCKET = 'uploads';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ---------- helpers ---------- */
function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function safeUrl(u) {
    try {
        const x = new URL(u);
        return (x.protocol === 'http:' || x.protocol === 'https:') ? x.href : '';
    } catch { return ''; }
}

function fmtDate(iso) {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}

function downloadUrl(url, name) {
    return url.includes('/storage/v1/object/public/')
        ? `${url}?download=${encodeURIComponent(name || 'file')}`
        : url;
}

function inferSubjectFromProject(r) {
    if (r.subject && String(r.subject).trim() !== '') return r.subject.trim();
    const tags = (r.tags || []).filter(t => !/^reflect:/i.test(String(t))).join(' ').toLowerCase();
    const text = `${r.title || ''} ${r.description || ''} ${tags}`.toLowerCase();
    if (text.includes('research') || text.includes('capstone') || text.includes('manuscript') || r.category === 'pdf') {
        return 'Research & Capstone';
    }
    if (text.includes('art') || text.includes('design') || text.includes('animation') || text.includes('video') || r.category === 'image' || r.category === 'video') {
        return 'Visual Arts & Media';
    }
    if (text.includes('business') || text.includes('entrepreneur') || text.includes('plan')) {
        return 'Entrepreneurship';
    }
    if (text.includes('science') || text.includes('hazard') || text.includes('biology') || text.includes('physics')) {
        return 'Science & STEM';
    }
    return 'Coding & ICT';
}

/* ---------- academic terms (DepEd calendars) ---------- */
// SY 2025–2026: two semesters (DepEd Order No. 12, s. 2025).
// SY 2026–2027: three terms (DepEd Order No. 009, s. 2026).
// Break periods are attached to the term that just ended so every upload
// date resolves to a label.
const CFSI_TERM_CALENDARS = [
    {
        schoolYear: 'SY 2025–2026',
        terms: [
            { label: '1st Sem', start: '2025-06-16', end: '2025-11-02' },
            { label: '2nd Sem', start: '2025-11-03', end: '2026-06-07' }
        ]
    },
    {
        schoolYear: 'SY 2026–2027',
        terms: [
            { label: 'Term 1', start: '2026-06-08', end: '2026-09-15' },
            { label: 'Term 2', start: '2026-09-16', end: '2027-01-03' },
            { label: 'Term 3', start: '2027-01-04', end: '2027-06-07' }
        ]
    }
];

function localDateKey(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function academicTermForDate(date) {
    if (!(date instanceof Date) || isNaN(date.getTime())) return '';
    const key = localDateKey(date);
    for (const calendar of CFSI_TERM_CALENDARS) {
        for (const term of calendar.terms) {
            if (key >= term.start && key <= term.end) {
                return `${calendar.schoolYear} • ${term.label}`;
            }
        }
    }
    return '';
}

function currentAcademicTerm(date = new Date()) {
    return academicTermForDate(date) || fallbackAcademicTerm(date);
}

function fallbackAcademicTerm(date) {
    if (!(date instanceof Date) || isNaN(date.getTime())) return '';
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    return month >= 6
        ? `SY ${year}–${year + 1} • 1st Sem`
        : `SY ${year - 1}–${year} • 2nd Sem`;
}

function academicTermOptions() {
    const options = [];
    CFSI_TERM_CALENDARS.forEach(calendar => {
        calendar.terms.forEach(term => {
            options.push(`${calendar.schoolYear} • ${term.label}`);
        });
    });
    return options.reverse();
}

function academicTermRank(term) {
    const text = String(term || '');
    const year = text.match(/SY\s*(\d{4})/i);
    const ordinal = text.match(/(?:term|sem)\s*([123])/i) || text.match(/([123])(?:st|nd|rd|th)\s*sem/i);
    return (year ? Number(year[1]) : 0) * 10 + (ordinal ? Number(ordinal[1]) : 0);
}

function inferTermFromProject(r) {
    const stored = r.term && String(r.term).trim() ? String(r.term).trim() : '';
    const legacyTrimesterYear = /^SY\s*2026\s*[–-]\s*2027\s*•\s*[12](?:st|nd)\s*Sem$/i.test(stored);

    if (stored && !legacyTrimesterYear) return stored;

    if (r.created_at) {
        const created = new Date(r.created_at);
        const inferred = academicTermForDate(created) || fallbackAcademicTerm(created);
        if (inferred) return inferred;
    }

    return stored || currentAcademicTerm();
}

/* ---------- guided portfolio reflections ---------- */
function decodeReflectionTag(tag) {
    if (!/^reflect:/i.test(String(tag || ''))) return null;
    try {
        const bin = atob(String(tag).slice(8));
        const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch { return null; }
}

function normalizeReflection(value) {
    let data = value;
    if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { return []; }
    }
    if (!Array.isArray(data)) return [];
    const out = [];
    data.forEach(entry => {
        if (!entry) return;
        const prompt = String(entry.prompt ?? entry.q ?? entry[0] ?? '').trim();
        const answer = String(entry.answer ?? entry.a ?? entry[1] ?? '').trim();
        if (prompt && answer) out.push({ prompt, answer });
    });
    return out;
}

function parseProjectReflection(r) {
    const direct = normalizeReflection(r.reflection);
    if (direct.length) return direct;
    for (const tag of (r.tags || [])) {
        const list = normalizeReflection(decodeReflectionTag(tag));
        if (list.length) return list;
    }
    return [];
}

function reflectionBlockHtml(reflection) {
    const list = normalizeReflection(reflection);
    if (!list.length) return '';
    return `
        <div class="reflection-title"><i class="fa-solid fa-compass"></i> Guided Reflection</div>
        ${list.map(r => `
            <div class="reflection-entry">
                <p class="reflection-q">${esc(r.prompt)}</p>
                <p class="reflection-a">${esc(r.answer)}</p>
            </div>`).join('')}`;
}

/* ---------- session ---------- */
async function getUser() {
    const { data } = await sb.auth.getSession();
    return data.session ? data.session.user : null;
}

async function requireLogin() {
    const user = await getUser();
    if (!user) { window.location.href = 'login.html'; return null; }
    return user;
}

async function getMyProfile() {
    const user = await getUser();
    if (!user) return null;

    const { data, error } = await sb
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .maybeSingle();

    if (!error && data) return data;

    // Fallback: build profile from auth user metadata if row is missing
    const meta = user.user_metadata || {};
    const parsedAge = meta.age !== undefined && meta.age !== '' ? Number(meta.age) : null;
    const fallbackProfile = {
        id: user.id,
        role: meta.role || 'student',
        fname: meta.fname || '',
        lname: meta.lname || '',
        bdate: meta.bdate || null,
        age: Number.isFinite(parsedAge) ? parsedAge : null,
        sex: meta.sex || '',
        strand: meta.strand || '',
        grade: meta.grade || '',
        section: meta.section || '',
        email: user.email || '',
        bio: '',
        avatar_url: '',
        avatar_path: ''
    };

    if (fallbackProfile.fname && fallbackProfile.lname && fallbackProfile.email) {
        const { data: inserted } = await sb
            .from('profiles')
            .upsert(fallbackProfile, { onConflict: 'id' })
            .select('*')
            .maybeSingle();
        if (inserted) return inserted;
    }

    return fallbackProfile;
}

async function logoutAccount() {
    await sb.auth.signOut();
}

/* ---------- sign up / log in ---------- */
async function registerAccount(profile, password) {
    const { data, error } = await sb.auth.signUp({
        email: profile.email,
        password,
        options: {
            data: {
                role: 'student',
                fname: profile.fname,
                lname: profile.lname,
                bdate: profile.bdate,
                age: profile.age,
                sex: profile.sex,
                strand: profile.strand,
                grade: profile.grade,
                section: profile.section,
                face_check: profile.faceCheck || '',
                face_result: profile.faceResult || ''
            }
        }
    });
    if (error) throw new Error(error.message);
    if (!data.session) throw new Error('Account created. Please confirm your email, then log in.');

    ['fname', 'lname', 'bdate', 'age', 'sex', 'strandbtn', 'glbtn', 'secbtn', 'sebtn', 'cfsi_pending_signup']
        .forEach(k => localStorage.removeItem(k));
    return data.user;
}

async function loginAccount(identifier, password) {
    const email = identifier.trim().toLowerCase();
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw new Error('Incorrect email or password.');
}

/* ---------- parent accounts & linking ---------- */
function normalizeParentCode(code) {
    return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function getMyRole() {
    const profile = await getMyProfile();
    return (profile && profile.role) || 'student';
}

async function registerParent(profile, password) {
    const email = String(profile.email || '').trim().toLowerCase();
    const { data, error } = await sb.auth.signUp({
        email,
        password,
        options: {
            data: {
                role: 'parent',
                fname: profile.fname,
                lname: profile.lname,
                face_check: profile.faceCheck || '',
                face_result: profile.faceResult || ''
            }
        }
    });
    if (error) throw new Error(error.message);
    if (!data.session) throw new Error('Account created. Please confirm your email, then log in.');

    // The profiles row (including role) is created by the auth.users trigger.
    return data.user;
}

async function getParentLinkCode() {
    const { data, error } = await sb.rpc('ensure_parent_link_code');
    if (error) throw new Error(error.message || 'Could not load your Parent Link Code.');
    return data;
}

async function requestParentLink(code, message) {
    const normalized = normalizeParentCode(code);
    if (!normalized) throw new Error('Enter your child\'s Parent Link Code.');

    const { data, error } = await sb.rpc('request_parent_link', {
        p_code: normalized,
        p_message: message || null
    });
    if (error) throw new Error(error.message || 'Could not send the link request.');
    return data;
}

async function respondParentLink(linkId, approve) {
    const { data, error } = await sb.rpc('respond_parent_link', {
        p_link_id: linkId,
        p_approve: !!approve
    });
    if (error) throw new Error(error.message || 'Could not update this request.');
    return data;
}

async function revokeParentLink(linkId) {
    const { error } = await sb.rpc('revoke_parent_link', { p_link_id: linkId });
    if (error) throw new Error(error.message || 'Could not remove this link.');
}

async function getMyChildren() {
    const { data, error } = await sb.rpc('my_children');
    if (error) throw new Error(error.message || 'Could not load your children.');
    return data || [];
}

async function getMyParentLinks() {
    const { data, error } = await sb.rpc('my_parent_links');
    if (error) throw new Error(error.message || 'Could not load parent links.');
    return data || [];
}

/* ---------- teacher accounts ---------- */
async function registerTeacher(profile, password) {
    const email = String(profile.email || '').trim().toLowerCase();
    const { data, error } = await sb.auth.signUp({
        email,
        password,
        options: {
            data: {
                role: 'teacher',
                fname: profile.fname,
                lname: profile.lname,
                face_check: profile.faceCheck || '',
                face_result: profile.faceResult || ''
            }
        }
    });
    if (error) throw new Error(error.message);
    if (!data.session) throw new Error('Account created. Please confirm your email, then log in.');

    // The profiles row (including role) is created by the auth.users trigger.
    return data.user;
}

/* ---------- teacher reviews: feedback, rubric, milestones ---------- */
const RUBRIC_CRITERIA = [
    { key: 'content', label: 'Content & Relevance' },
    { key: 'creativity', label: 'Creativity & Originality' },
    { key: 'execution', label: 'Execution & Craftsmanship' },
    { key: 'organization', label: 'Organization & Clarity' },
    { key: 'impact', label: 'Impact & Presentation' }
];
const RUBRIC_MAX_TOTAL = RUBRIC_CRITERIA.length * 5;
const MILESTONE_STAGES = [
    { key: 'proposal', label: 'Proposal' },
    { key: 'draft', label: 'Draft' },
    { key: 'final', label: 'Final' }
];

function mapTeacherReview(r) {
    return {
        id: r.id,
        teacherId: r.teacher_id,
        teacherName: r.teacher_name || 'Teacher',
        studentId: r.student_id,
        projectId: r.project_id,
        featuredSlot: r.featured_slot,
        kind: r.kind,
        message: r.message || '',
        scores: r.scores || null,
        totalScore: r.total_score == null ? null : Number(r.total_score),
        stage: r.stage || '',
        status: r.status || '',
        createdAt: r.created_at,
        updatedAt: r.updated_at
    };
}

async function submitTeacherReview(payload) {
    const { data, error } = await sb.rpc('submit_teacher_review', {
        p_kind: payload.kind,
        p_project_id: payload.projectId ?? null,
        p_featured_owner: payload.featuredOwnerId ?? null,
        p_featured_slot: payload.featuredSlot ?? null,
        p_message: payload.message || null,
        p_scores: payload.scores || null,
        p_stage: payload.stage || null,
        p_status: payload.status || null
    });
    if (error) throw new Error(error.message || 'Could not save this review.');
    return mapTeacherReview(data);
}

async function getProjectReviews(projectId) {
    const { data, error } = await sb.from('teacher_reviews')
        .select('*')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false });
    if (error) throw new Error(error.message || 'Could not load teacher reviews.');
    return (data || []).map(mapTeacherReview);
}

async function getFeaturedReviews(slot) {
    const { data, error } = await sb.from('teacher_reviews')
        .select('*')
        .eq('featured_slot', slot)
        .order('created_at', { ascending: false });
    if (error) throw new Error(error.message || 'Could not load teacher reviews.');
    return (data || []).map(mapTeacherReview);
}

function renderTeacherReviewsHtml(reviews) {
    if (!reviews || !reviews.length) {
        return `<div class="tr-empty"><i class="fa-regular fa-comment-dots"></i> No teacher reviews yet.</div>`;
    }

    const feedback = reviews.filter(r => r.kind === 'feedback');
    const rubrics = reviews.filter(r => r.kind === 'rubric');
    const milestones = reviews.filter(r => r.kind === 'milestone');

    const feedbackHtml = feedback.length ? `
        <section class="tr-section">
            <h5><i class="fa-solid fa-comment-dots"></i> Feedback</h5>
            ${feedback.map(r => `
                <div class="tr-item">
                    <div class="tr-head">
                        <span class="tr-name">${esc(r.teacherName)}</span>
                        <span class="tr-date">${esc(fmtDate(r.createdAt))}</span>
                    </div>
                    <p class="tr-msg">${esc(r.message)}</p>
                </div>`).join('')}
        </section>` : '';

    const rubricHtml = rubrics.length ? `
        <section class="tr-section">
            <h5><i class="fa-solid fa-clipboard-list"></i> Rubric Scores</h5>
            ${rubrics.map(r => `
                <div class="tr-item">
                    <div class="tr-head">
                        <span class="tr-name">${esc(r.teacherName)}</span>
                        <span class="tr-total">${r.totalScore == null ? '\u2014' : r.totalScore} / ${RUBRIC_MAX_TOTAL}</span>
                    </div>
                    <div class="tr-rubric-grid">
                        ${RUBRIC_CRITERIA.map(c => {
                            const v = r.scores && r.scores[c.key] != null ? Number(r.scores[c.key]) : 0;
                            return `<div class="tr-rubric-row"><span>${esc(c.label)}</span><strong>${v ? `${v}/5` : '\u2014'}</strong></div>`;
                        }).join('')}
                    </div>
                    ${r.message ? `<p class="tr-msg">${esc(r.message)}</p>` : ''}
                    <span class="tr-date">${esc(fmtDate(r.createdAt))}</span>
                </div>`).join('')}
        </section>` : '';

    const milestonesHtml = milestones.length ? `
        <section class="tr-section">
            <h5><i class="fa-solid fa-flag-checkered"></i> Milestone Reviews</h5>
            ${milestones.map(r => {
                const stageLabel = (MILESTONE_STAGES.find(s => s.key === r.stage) || {}).label || r.stage;
                const approved = r.status === 'approved';
                return `
                <div class="tr-item">
                    <div class="tr-head">
                        <span class="tr-name">${esc(r.teacherName)} \u00b7 ${esc(stageLabel)}</span>
                        <span class="tr-status ${approved ? 'is-approved' : 'is-revision'}">${approved ? 'Approved' : 'Needs Revision'}</span>
                    </div>
                    ${r.message ? `<p class="tr-msg">${esc(r.message)}</p>` : ''}
                    <span class="tr-date">${esc(fmtDate(r.createdAt))}</span>
                </div>`;
            }).join('')}
        </section>` : '';

    return feedbackHtml + rubricHtml + milestonesHtml;
}

/* ---------- file storage ---------- */
async function uploadFile(file, uid, folder) {
    const safeName = file.name.replace(/[^\w.\-]+/g, '_');
    const path = `${uid}/${folder}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeName}`;
    const { error } = await sb.storage.from(BUCKET).upload(path, file, {
        contentType: file.type || 'application/octet-stream',
        upsert: false
    });
    if (error) throw new Error(error.message);
    const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
    return { path, url: data.publicUrl };
}

async function removeFile(path) {
    if (path) await sb.storage.from(BUCKET).remove([path]);
}

/* ---------- live web / app previews ---------- */
function extractLiveUrlFromTags(tags) {
    const hit = (tags || []).find(t => /^live:/i.test(String(t)));
    return hit ? safeUrl(String(hit).slice(5)) : '';
}

function isHtmlProject(item) {
    if (!item) return false;
    return String(item.mimeType || '').toLowerCase().includes('html')
        || /\.html?$/i.test(item.fileName || '')
        || /\.html?$/i.test(item.fileUrl || '');
}

function getLivePreviewUrl(item) {
    if (!item) return '';
    // Teams/SharePoint links need a Microsoft account, so they are never iframed.
    if (item.teamsUrl && (item.fileUrl === item.teamsUrl || item.liveUrl === item.teamsUrl)) return '';
    if (item.liveUrl) return item.liveUrl;
    if (item.category === 'link') return item.fileUrl || '';
    if (isHtmlProject(item)) return item.fileUrl || '';
    return '';
}

/* ---------- Microsoft Teams artifacts (link + optional imported copy) ---------- */
const CFSI_TEAMS_HOSTS = new Set([
    'teams.microsoft.com',
    'teams.live.com',
    'forms.office.com',
    '1drv.ms',
    'onedrive.live.com',
    'web.microsoftstream.com'
]);
const CFSI_TEAMS_HOST_SUFFIXES = ['.sharepoint.com', '.office.com', '.microsoftstream.com'];

function isMicrosoftArtifactHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (!host) return false;
    return CFSI_TEAMS_HOSTS.has(host)
        || CFSI_TEAMS_HOST_SUFFIXES.some(suffix => host.endsWith(suffix));
}

function normalizeTeamsUrl(raw) {
    let value = String(raw || '').trim();
    if (!value) return '';
    if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
    try {
        const u = new URL(value);
        if (u.protocol !== 'https:') return '';
        if (u.username || u.password) return '';
        if (!isMicrosoftArtifactHost(u.hostname)) return '';
        return u.href;
    } catch {
        return '';
    }
}

function extractTeamsUrlFromTags(tags) {
    const hit = (tags || []).find(t => /^teams:/i.test(String(t)));
    return hit ? normalizeTeamsUrl(String(hit).slice(6)) : '';
}

function teamsArtifactKind(url) {
    let u;
    try { u = new URL(url); } catch { return 'teams'; }
    const host = u.hostname.toLowerCase();
    const path = (u.pathname + u.search).toLowerCase();

    if (host === 'forms.office.com' || /\/forms?\//i.test(path)) return 'form';
    if (/onenote|\.one(\?|#|$)/i.test(path) || /\/:[a-z]*o[a-z]*:/i.test(path)) return 'notebook';
    if (host === 'web.microsoftstream.com' || /recording|stream\.aspx/i.test(path)) return 'recording';
    if (/\/l\/assignment|\/l\/class/i.test(path)) return 'assignment';
    if (/\/l\/meet|\/l\/call/i.test(path)) return 'meeting';
    if (/\/l\/(channel|chat|message|conversation|team)\b/i.test(path)) return 'chat';
    if (host === '1drv.ms' || host === 'onedrive.live.com'
        || host.endsWith('.sharepoint.com') || host.endsWith('.office.com')
        || /\/:[a-z]+\//i.test(path)) return 'file';
    return 'teams';
}

function teamsKindMeta(kind) {
    const map = {
        file: { label: 'Microsoft 365 file', icon: 'fa-file-lines' },
        recording: { label: 'Meeting recording', icon: 'fa-circle-play' },
        notebook: { label: 'OneNote notebook', icon: 'fa-book-open' },
        form: { label: 'Microsoft Form', icon: 'fa-square-poll-vertical' },
        chat: { label: 'Teams conversation', icon: 'fa-comments' },
        assignment: { label: 'Teams assignment', icon: 'fa-clipboard-list' },
        meeting: { label: 'Teams meeting', icon: 'fa-video' },
        teams: { label: 'Microsoft Teams artifact', icon: 'fa-people-group' }
    };
    return map[kind] || map.teams;
}

function teamsActionLabel(url) {
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch { return 'Open in Microsoft Teams'; }
    if (host === 'forms.office.com') return 'Open Microsoft Form';
    if (host.endsWith('.sharepoint.com') || host.endsWith('.office.com')
        || host === '1drv.ms' || host === 'onedrive.live.com') return 'Open in Microsoft 365';
    return 'Open in Microsoft Teams';
}

/* ---------- skill tags ---------- */
function parseSkillInput(raw) {
    const out = [];
    String(raw || '')
        .split(/[,;]+/)
        .map(v => v.trim().replace(/^#/, '').replace(/^skill:/i, '').replace(/\s+/g, ' '))
        .forEach(v => {
            if (v && v.length <= 32 && !out.some(x => x.toLowerCase() === v.toLowerCase())) {
                out.push(v);
            }
        });
    return out.slice(0, 10);
}

function normalizeSkillList(raw) {
    if (Array.isArray(raw)) return parseSkillInput(raw.join(','));
    return parseSkillInput(raw);
}

function extractSkillsFromTags(tags) {
    const hits = (tags || [])
        .filter(t => /^skill:/i.test(String(t)))
        .map(t => String(t).slice(6));
    return normalizeSkillList(hits);
}

function mergeSkills(a, b) {
    const out = [];
    [...(a || []), ...(b || [])].forEach(v => {
        const s = String(v || '').trim();
        if (s && !out.some(x => x.toLowerCase() === s.toLowerCase())) out.push(s);
    });
    return out.slice(0, 10);
}

/* ---------- map a DB row to the object the pages use ---------- */
function mapProject(r) {
    const rawTags = r.tags || [];
    const teamsUrl = safeUrl(r.teams_url || '') || extractTeamsUrlFromTags(rawTags);
    return {
        id: r.id,
        authorId: r.user_id,
        author: r.author || 'CFSI Student',
        title: r.title,
        groupTitle: r.group_title,
        fileName: r.file_name,
        category: r.category,
        subject: inferSubjectFromProject(r),
        term: inferTermFromProject(r),
        size: Number(r.size_mb) || 0,
        desc: r.description || '',
        tags: rawTags.filter(t => !/^live:/i.test(String(t)) && !/^skill:/i.test(String(t)) && !/^reflect:/i.test(String(t)) && !/^teams:/i.test(String(t))),
        skills: mergeSkills(normalizeSkillList(r.skills), extractSkillsFromTags(rawTags)),
        reflection: parseProjectReflection(r),
        date: fmtDate(r.created_at),
        timestamp: new Date(r.created_at).getTime(),
        fileUrl: safeUrl(r.file_url),
        liveUrl: safeUrl(r.live_url || '') || extractLiveUrlFromTags(rawTags),
        teamsUrl,
        teamsKind: teamsUrl ? teamsArtifactKind(teamsUrl) : '',
        storagePath: r.storage_path,
        mimeType: r.mime_type || '',
        isPublic: r.is_public,
        visibility: ['private', 'teacher', 'parents', 'public'].includes(r.visibility)
            ? r.visibility
            : (r.is_public ? 'public' : 'private'),
        shareToken: r.share_token || '',
        shareEnabled: r.share_enabled === true,
        batchId: r.batch_id
    };
}