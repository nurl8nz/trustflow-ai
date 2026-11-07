// Pre-analyzed examples. They go through the same normalization as live AI
// output, so judges can try the whole PayPal flow even without an AI key.

export const SAMPLES = {
  bakery: {
    text: 'I need a modern website for my bakery, Rosa’s Bread Corner. Budget is $900: $300 for the design, $400 for development, and $200 after testing. It should look good on phones and be done in about a month. I’ll send photos of our bread.',
    analysis: {
      title: 'Website for Rosa’s Bread Corner',
      summary: 'A freelance web designer builds a website for a local bakery. Payment is split into design, development and a final payment after testing.',
      currency: 'USD',
      stated_total: 900,
      client_label: 'Rosa (bakery owner)',
      freelancer_label: 'Web designer',
      milestones: [
        {
          title: 'Design',
          description: 'Visual design of the site before any code is written.',
          deliverables: ['Mockups for [number] pages', 'Color palette and fonts', 'Mobile and desktop versions of each mockup'],
          acceptance_criteria: ['Mockups cover all [number] agreed pages', 'Each page has a phone and a desktop version', 'Rosa has had [number] rounds of revisions'],
          amount: 300,
          amount_source: 'stated',
          due_hint: 'Week 1–2',
        },
        {
          title: 'Development',
          description: 'Build the approved design as a working website.',
          deliverables: ['Working site on a preview link', 'Menu with prices', 'Contact details and opening hours'],
          acceptance_criteria: ['Every approved page opens on the preview link', 'Pages load in under 3 seconds on a phone', 'Menu shows every item with its price'],
          amount: 400,
          amount_source: 'stated',
          due_hint: 'Week 3',
        },
        {
          title: 'Testing and launch',
          description: 'Fix issues found in testing and publish the site.',
          deliverables: ['Site live on Rosa’s domain', 'List of fixed issues', 'Login details handed over'],
          acceptance_criteria: ['Site works on [devices/browsers]', 'No broken links or missing images', 'Rosa can log in and edit opening hours herself'],
          amount: 200,
          amount_source: 'stated',
          due_hint: 'Week 4',
        },
      ],
      gaps: [
        { severity: 'high', topic: 'Scope', quote: 'modern website', issue: '“Modern” does not say which pages or features are included.', risk: 'The client may expect online ordering while the designer plans three static pages.', question: 'Which pages should the site have, for example Home, Menu, About and Contact?', suggested_clause: 'The site includes these pages: Home, Menu, About, Contact. Anything else is quoted separately.' },
        { severity: 'high', topic: 'Acceptance', quote: 'after testing', issue: 'It is unclear who tests, what counts as passing, and how long the client has to respond.', risk: 'The last $200 can stay unpaid indefinitely if testing never formally ends.', question: 'Who tests the site, and how many days does the client have to report problems?', suggested_clause: 'Rosa tests the site within 5 days of the preview link. Without reported issues, the milestone counts as approved.' },
        { severity: 'medium', topic: 'Revisions', quote: null, issue: 'The number of design revisions is not mentioned.', risk: 'Endless rounds of small changes become unpaid work.', question: 'How many rounds of design changes are included?', suggested_clause: 'The design price includes 2 rounds of revisions. Further rounds cost $40 each.' },
        { severity: 'medium', topic: 'Devices', quote: 'look good on phones', issue: '“Look good” on phones is not something either side can check.', risk: 'A disagreement about one old phone model can block the final payment.', question: 'Which phones and browsers must the site work on?', suggested_clause: 'The site is tested on the latest iPhone Safari and Android Chrome, plus Chrome and Safari on desktop.' },
        { severity: 'medium', topic: 'Deadline', quote: 'about a month', issue: 'There is no fixed date, and no rule for delays caused by late photos or text.', risk: 'Each side can blame the other for a late launch.', question: 'What is the launch date, and does it move if photos or texts arrive late?', suggested_clause: 'Launch is on [date]. The date moves by the number of days content is late.' },
        { severity: 'low', topic: 'Content', quote: 'I’ll send photos', issue: 'Photos are covered, but not texts, the menu or the logo.', risk: 'The designer may wait on content while the deadline runs.', question: 'Who writes the texts and provides the menu and logo, and by when?', suggested_clause: 'Rosa sends the menu, texts and logo within 7 days of signing.' },
        { severity: 'low', topic: 'Ownership', quote: null, issue: 'Hosting, the domain and ownership of the files are not mentioned.', risk: 'The client may later find the site registered in the designer’s name.', question: 'Who pays for hosting and the domain, and who owns the design files?', suggested_clause: 'The domain and hosting are in Rosa’s name. All files transfer to Rosa after the final payment.' },
      ],
    },
  },
  tutoring: {
    text: 'Math tutoring for my son Daniel (grade 9) to get him ready for his finals. 10 lessons, $40 each, twice a week online. I’ll pay after every 5 lessons. If he misses a lesson it’s on us, but please be flexible.',
    analysis: {
      title: 'Math tutoring for Daniel',
      summary: 'A tutor gives a grade 9 student ten online math lessons before his finals. The parent pays $200 after each block of five lessons.',
      currency: 'USD',
      stated_total: 400,
      client_label: 'Daniel’s parent',
      freelancer_label: 'Math tutor',
      milestones: [
        {
          title: 'Lessons 1 to 5',
          description: 'First block of five online lessons, twice a week.',
          deliverables: ['5 online lessons of [length] minutes', 'Short note after each lesson on topics covered'],
          acceptance_criteria: ['5 lessons took place or were missed by the student without [hours] notice', 'Each lesson lasted at least [length] minutes', 'Parent received a note on topics covered'],
          amount: 200,
          amount_source: 'stated',
          due_hint: 'Weeks 1–3',
        },
        {
          title: 'Lessons 6 to 10',
          description: 'Second block of five lessons focused on finals preparation.',
          deliverables: ['5 online lessons of [length] minutes', 'One practice test with feedback'],
          acceptance_criteria: ['5 more lessons took place or were missed by the student without [hours] notice', 'Daniel completed one practice test and received written feedback'],
          amount: 200,
          amount_source: 'stated',
          due_hint: 'Weeks 3–5',
        },
      ],
      gaps: [
        { severity: 'high', topic: 'Rescheduling', quote: 'please be flexible', issue: '“Flexible” does not say how much notice is needed to move a lesson.', risk: 'A last-minute cancellation can turn into an argument about whether it is paid.', question: 'How many hours before a lesson can either side move it without it counting?', suggested_clause: 'Lessons can be moved for free with 12 hours’ notice. Later cancellations by the student count as held.' },
        { severity: 'medium', topic: 'Lesson length', quote: null, issue: 'The length of each lesson is not stated.', risk: 'A 45-minute lesson may feel short to a parent expecting an hour.', question: 'How long is each lesson?', suggested_clause: 'Each lesson lasts 60 minutes.' },
        { severity: 'medium', topic: 'Goal', quote: 'get him ready for his finals', issue: 'Readiness cannot be measured, and grades depend on the student too.', risk: 'A disappointing grade can lead to a refund request.', question: 'Which topics must be covered, and is the price tied to grades?', suggested_clause: 'The tutor covers the topics on the school’s finals list. Payment does not depend on grades.' },
        { severity: 'low', topic: 'Tutor absence', quote: 'it’s on us', issue: 'Missed lessons by the student are covered, but not missed lessons by the tutor.', risk: 'Unclear whether a tutor cancellation is refunded or rescheduled.', question: 'What happens if the tutor has to cancel a lesson?', suggested_clause: 'If the tutor cancels, the lesson is rescheduled within the same week or not charged.' },
        { severity: 'low', topic: 'Platform', quote: 'online', issue: 'The video platform and whether lessons are recorded are not mentioned.', risk: 'Small, but recordings matter if there is a dispute about a lesson.', question: 'Which video platform do you use, and are lessons recorded?', suggested_clause: 'Lessons run on Google Meet and are not recorded unless both sides agree.' },
      ],
    },
  },
};
