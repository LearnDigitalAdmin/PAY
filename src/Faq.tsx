import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';

const faqs = [
  {
    question: 'What is Plot Yangu?',
    answer:
      'Plot Yangu is a modern property management platform designed for landlords, agents, and caretakers. It automates rent invoicing, WhatsApp reminders, payments, and reporting — all in one simple dashboard.',
  },
  {
    question: 'How do payments work on Plot Yangu?',
    answer:
      'All payments are securely processed via Paystack. When a tenant pays through Plot Yangu, Paystack automatically processes the payment, and the landlord or agent receives their share directly after settlement.',
  },
  {
    question: 'When will landlords receive their money?',
    answer:
      'Paystack settles funds on a standard T+2 basis (two business days after the transaction). This ensures compliance and allows time for banks to clear the payment.',
  },
  {
    question: 'Are there any hidden charges?',
    answer:
      'No hidden fees. Paystack charges a small transaction fee (1.5% for local, 2.9% for international transactions), and Plot Yangu adds a 1.5% platform fee. Both are transparent and clearly shown before payment.',
  },
  {
    question: 'Do landlords or agents need a Paystack account?',
    answer:
      'No, they don’t. Plot Yangu automatically creates a secure Paystack subaccount for each landlord or agent when onboarding, and payments are sent directly to their preferred bank or M-Pesa number.',
  },
  {
    question: 'Can tenants pay using M-Pesa or Airtel Money?',
    answer:
      'Yes! Tenants can pay using M-Pesa, Airtel Money, or even card payments. The process is smooth and designed for mobile-first use — especially on Android phones.',
  },
  {
    question: 'What if my internet is slow?',
    answer:
      'No worries — Plot Yangu is built as a Progressive Web App (PWA), meaning it runs smoothly even on slow networks and can be installed directly on your Android phone or PC.',
  },
  {
    question: 'Is my data safe?',
    answer:
      'Absolutely. All data is encrypted and stored securely. Payments are handled by Paystack, a PCI-DSS certified payment processor trusted across Africa.',
  },
  {
    question: 'Where can I get help or request a demo?',
    answer:
      'You can reach us anytime through our contact page for support or a live demo. Visit: https://cogvana.co.ke/contact',
  },
];

export default function FAQPage() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const navigate = useNavigate();
  // const
  

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center px-4 py-16">
      <div className="max-w-3xl w-full">
        <h1 className="text-4xl font-bold text-center text-gray-800 mb-10">
          Frequently Asked Questions
        </h1>
        <div className="space-y-4">
          {faqs.map((faq, index) => (
            <div
              key={index}
              className="bg-white rounded-2xl shadow-md overflow-hidden border border-gray-100 hover:shadow-lg transition duration-300"
            >
              <button
                onClick={() => setOpenIndex(openIndex === index ? null : index)}
                className="w-full flex justify-between items-center p-6 text-left focus:outline-none"
              >
                <span className="text-lg font-semibold text-gray-700">
                  {faq.question}
                </span>
                {openIndex === index ? (
                  <ChevronUp className="text-gray-500" />
                ) : (
                  <ChevronDown className="text-gray-500" />
                )}
              </button>

              <AnimatePresence initial={false}>
                {openIndex === index && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.3 }}
                    className="px-6 pb-6 text-gray-600"
                  >
                    {faq.answer}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>

        <div className="mt-12 text-center">
          <p className="text-gray-600 mb-2">Still have questions?</p>
          <a
          
            href="https://payments.cogvana.co.ke/contact"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block bg-blue-600 text-white font-semibold px-6 py-3 rounded-full hover:bg-blue-700 transition duration-300"
          >
            Contact Us
          </a>
        </div>
      </div>
    </div>
  );
}
navigate('/contact');