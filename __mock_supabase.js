/* Mock Supabase client for Microsoft Teams integration tests. */
(function () {
    const mockUser = {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'student@fatima.edu.ph',
        user_metadata: { role: 'student', fname: 'Test', lname: 'Student' }
    };
    const profile = {
        id: mockUser.id, role: 'student', fname: 'Test', lname: 'Student',
        grade: '12', strand: 'ICT', section: 'A', email: mockUser.email
    };

    const teamsLink = 'https://teams.microsoft.com/l/meetingrecording/meeting-abc-123?tenantId=school';
    const teamsFile = 'https://cfsi.sharepoint.com/:w:/r/sites/Capstone/Shared%20Documents/Final%20Paper.docx';

    const sampleProjects = [
        {
            id: 901, user_id: mockUser.id, author: 'Test Student',
            title: 'Capstone defense recording', group_title: 'Capstone defense recording',
            file_name: teamsLink, category: 'link', subject: 'Research & Capstone',
            term: 'SY 2026–2027 • Term 2', size_mb: 0,
            description: 'Recorded walkthrough of our capstone prototype, kept in Teams.',
            tags: ['#ResearchCapstone', '#MicrosoftTeams', 'teams:' + teamsLink],
            skills: ['Research Writing'], file_url: teamsLink, live_url: null,
            mime_type: 'text/uri-list', is_public: true, visibility: 'public',
            created_at: '2026-11-10T08:00:00Z'
        },
        {
            id: 902, user_id: mockUser.id, author: 'Test Student',
            title: 'Final paper (imported copy)', group_title: 'Final paper (imported copy)',
            file_name: 'Final Paper.docx', category: 'document', subject: 'Research & Capstone',
            term: 'SY 2026–2027 • Term 2', size_mb: 1.5,
            description: 'Downloaded from Teams and attached for permanent storage.',
            tags: ['#ResearchCapstone', '#MicrosoftTeams', 'teams:' + teamsFile],
            skills: ['Research Writing'],
            file_url: 'https://tgwmeyxtgdlljyrqfopb.supabase.co/storage/v1/object/public/uploads/mock/final.docx',
            live_url: null,
            mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            is_public: true, visibility: 'public', created_at: '2026-11-09T08:00:00Z'
        }
    ];

    const sharedRow = {
        title: 'Capstone defense recording', author: 'Test Student',
        category: 'link', subject: 'Research & Capstone', term: 'SY 2026–2027 • Term 2',
        description: 'Recorded walkthrough of our capstone prototype, kept in Teams.',
        tags: ['#ResearchCapstone', '#MicrosoftTeams', 'teams:' + teamsLink],
        skills: ['Research Writing'], reflection: null,
        file_url: teamsLink, file_name: teamsLink, live_url: null, size_mb: 0,
        created_at: '2026-11-10T08:00:00Z', is_public: true, visibility: 'public'
    };

    const page = String(window.location.pathname || '');
    const isCommunity = page.includes('__mock_community');
    const hasShowcase = isCommunity || page.includes('__mock_index');

    const featuredRows = [
        { user_id: mockUser.id, slot: 1, image_url: 'https://picsum.photos/seed/f1/640/420', caption: 'Capstone poster' },
        { user_id: mockUser.id, slot: 2, image_url: 'https://picsum.photos/seed/f2/640/420', caption: '' }
    ];

    const tables = {
        profiles: [profile],
        projects: hasShowcase ? sampleProjects : [],
        ratings: [],
        exhibitions: [],
        exhibition_items: [],
        teacher_reviews: [],
        featured_ratings: [],
        featured: hasShowcase ? featuredRows : [],
        public_profiles: hasShowcase
            ? [{ id: mockUser.id, fname: 'Test', lname: 'Student', avatar_url: null }]
            : []
    };
    const captured = { inserts: [] };
    window.__captured = captured;

    function rowsFor(table) { return (tables[table] || []).slice(); }

    function rpcFor(name) {
        if (name === 'community_directory') {
            return { data: [{ id: mockUser.id, fname: 'Test', lname: 'Student', grade: '12', strand: 'ICT' }], error: null };
        }
        if (name === 'get_shared_project') return { data: [sharedRow], error: null };
        if (name === 'set_project_share') return { data: [{ share_token: 'a'.repeat(32), share_enabled: true }], error: null };
        return { data: null, error: null };
    }

    function makeQuery(table) {
        const q = {};
        ['select', 'eq', 'neq', 'order', 'limit', 'or', 'is', 'not', 'match', 'in', 'range', 'filter']
            .forEach(m => { q[m] = () => q; });
        q.insert = rows => {
            captured.inserts.push({ table, rows });
            (tables[table] = tables[table] || []).push(...(Array.isArray(rows) ? rows : [rows]));
            return q;
        };
        q.upsert = q.insert;
        q.update = rows => {
            captured.updates = captured.updates || [];
            captured.updates.push({ table, rows });
            return q;
        };
        q.delete = () => q;
        q.single = () => Promise.resolve({ data: rowsFor(table)[0] || null, error: null });
        q.maybeSingle = () => Promise.resolve(table === 'profiles'
            ? { data: profile, error: null }
            : { data: null, error: null });
        q.then = (res, rej) => Promise.resolve({ data: rowsFor(table), error: null }).then(res, rej);
        return q;
    }

    const mockClient = {
        auth: {
            getSession: async () => ({ data: { session: { user: mockUser } }, error: null }),
            getUser: async () => ({ data: { user: mockUser }, error: null }),
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
            signOut: async () => ({ error: null })
        },
        from(table) { return makeQuery(table); },
        rpc(name) { return Promise.resolve(rpcFor(name)); },
        functions: {
            invoke: async () => ({ data: { flagged: false, reasons: [], checks: {} }, error: null })
        },
        storage: {
            from() {
                return {
                    upload: async () => ({ data: { path: 'mock/imported-file.png' }, error: null }),
                    remove: async () => ({ data: null, error: null }),
                    getPublicUrl: () => ({
                        data: { publicUrl: 'https://tgwmeyxtgdlljyrqfopb.supabase.co/storage/v1/object/public/uploads/mock/imported-file.png' }
                    })
                };
            }
        },
        channel() {
            return { on() { return this; }, subscribe() { return this; } };
        },
        removeChannel() {}
    };

    window.supabase = { createClient: () => mockClient };
})();
