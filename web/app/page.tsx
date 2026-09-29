import { redirect } from 'next/navigation';

// The landing page adds nothing; go straight to the chat.
export default function Home() {
  redirect('/chat');
}
