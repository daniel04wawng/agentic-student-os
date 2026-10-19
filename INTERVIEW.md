# Explaining this project (plain-language guide)

This is written for talking about the project out loud, in an interview or to someone
non-technical. No code. The goal is that you can explain what it is, why it exists, and
how it works, and answer the follow-up questions honestly.

Read the three pitches, pick the "how it works" story, and skim the Q&A. That is enough.

---

## The one-liner

"It is a study assistant for a university course that answers your questions using your
actual course material, and shows you where each answer came from."

## The 30-second version

"Students get a pile of readings, primers, and lecture notes, and the hard part is not
reading them once, it is finding the right thing when you have a question. So I built a
chat assistant that is grounded in the real course material. You ask it something in
plain English, it finds the relevant passages from the course, and it answers using
only those, with citations you can click to see the source. I also turned the physical
course textbook into a readable in-app version, and made it aware of the class schedule,
so you can ask things like 'what should I read for next class'."

## The 2-minute version

"The problem is that studying is really a search problem. The material exists, but when
you have a specific question the night before class, you do not want to re-read a
hundred pages, you want the answer and the one paragraph it came from.

So the core is a chat assistant, but with an important rule: it only answers from your
course material, and it cites its sources. It does not make things up. If the material
does not cover something, it tells you.

To make that work I had to get the material in. The main textbook only existed as a
physical book, so I photographed all 137 pages and converted them to text, cleaned up
the scanning errors, and even re-did the table pages with an image-reading model because
tables scan badly. I connected it to the school's system to pull in the readings and the
class schedule, so it knows which primer goes with which session.

On the technical side I kept it cheap to run. The expensive part is the AI model, so it
only runs when someone is actually asking a question and shuts off when idle. And I added
a little traffic dashboard so I can see how many people use it."

---

## How it works, explained simply

Use this analogy if someone asks you to walk through it:

"Think of it like an open-book exam with a very fast research assistant.

1. You ask a question.
2. Instead of guessing, the assistant first goes and finds the handful of most relevant
   pages from your course material. It does this two ways at once: by meaning (so it
   finds the right passage even if you used different words than the book) and by exact
   keywords (so terms like 'Session 8' match literally). Then it combines both.
3. It hands those pages to the AI and says: answer the question using only this, and
   point to which page each part came from.
4. You get the answer with little clickable tags that open the exact source."

The key idea to land: the AI is not answering from memory, it is answering from the
specific material it just looked up. That is what makes it trustworthy for studying.

---

## The parts worth talking about

Pick the one or two that fit the conversation.

- **Digitizing the whole textbook.** "The book was physical, so I photographed every
  page, ran it through text recognition, and cleaned it up. The tricky part was tables,
  which scramble when you scan them, so I used an image-reading AI to redo just those
  pages." This shows persistence and problem-solving.

- **Grounded answers with citations.** "The assistant is not allowed to make things up.
  It answers only from the course material and shows its sources. For a study tool,
  being trustworthy matters more than being clever."

- **It understands the class schedule.** "It pulls the schedule from the school's
  system, so it knows which readings and which primer go with each session. You can ask
  'what do I need for session 8' and it just knows."

- **Keeping it cheap.** "The AI model is the only expensive piece, so I set it up to turn
  off when nobody is using it. The trade-off is the first question after a quiet period
  is a little slow while it wakes up, so I made the app wait through that gracefully
  instead of showing an error."

- **Knowing if it is used.** "I added a simple traffic dashboard so I can see page views
  and visitors, built into the app itself rather than relying on an outside service."

---

## Likely interview questions and simple answers

**"Walk me through how it works."**
Use the open-book-exam analogy above.

**"How does it know the answer is right / why does it not make things up?"**
"It does not answer from the AI's own memory. Every answer is built from passages it
pulled from the actual course material, and it is told to only use those and to cite
them. If the material does not cover it, it says so."

**"What was the hardest part?"**
"Getting a physical textbook into the system cleanly. Scanning a book is easy until you
hit the tables, which come out jumbled. I had to detect those pages and re-read them a
different way. The lesson was that the boring data-cleanup work is most of the quality."

**"Why did you build it this way / why these choices?"**
"Two reasons drove most of it: trust and cost. Trust meant grounding every answer in
real sources with citations. Cost meant the expensive AI part only runs on demand and
shuts off when idle, so it is basically free when nobody is using it."

**"What would you do differently or add next?"**
"Add accounts so each student gets their own material, and a simple usage limit per
person so costs stay predictable if a lot of people use it at once."

**"How is this different from just using ChatGPT?"**
"A general chatbot answers from everything it has ever seen and can confidently make
things up. This only answers from your specific course material and shows you the
source, so you can actually trust it for an exam."

**"What did you learn?"**
"That the interesting-sounding AI part is a small slice. Most of the real work is getting
clean data in, making it trustworthy, handling the edge cases, and keeping it cheap to
run."

---

## A few terms you might hear (one line each)

You do not need these to explain the project, but if an interviewer uses them, here is
what they mean in this context.

- **RAG (retrieval-augmented generation):** the open-book approach. Look up relevant
  material first, then have the AI answer from it. That is exactly what this does.
- **Embeddings / semantic search:** finding passages by meaning, not just matching
  words, so a reworded question still finds the right passage.
- **Grounding / citations:** forcing the AI to answer from supplied sources and point
  back to them.
- **OCR (optical character recognition):** turning a photo of text into actual text.
- **Scale-to-zero:** the expensive part turns off when idle so it costs nothing when
  unused, at the cost of a short warm-up on the first request.

---

## One honest framing to keep in your back pocket

If someone pushes on how much of it is "just AI", a strong and honest answer is:

"The AI model is a component I used, not the hard part. The work was the system around
it: getting a physical textbook in cleanly, connecting the school's data, making answers
trustworthy with citations, handling the pages that broke, and keeping it cheap enough to
leave running. That system is the project."
