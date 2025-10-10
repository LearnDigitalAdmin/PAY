// Contact.tsx - Contact Information Page
import React from 'react';
import { Mail, Phone, MessageCircle, ArrowLeft, ExternalLink } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

const Contact: React.FC = () => {
  const navigate = useNavigate();

  const contactMethods = [
    {
      icon: Mail,
      title: 'General Inquiries',
      value: 'info@cogvana.co.ke',
      href: 'mailto:info@cogvana.co.ke',
      color: 'text-blue-600',
      bgColor: 'bg-blue-50',
      description: 'For general questions and support'
    },
    {
      icon: Mail,
      title: 'Sales & Business',
      value: 'sales@cogvana.co.ke',
      href: 'mailto:sales@cogvana.co.ke',
      color: 'text-green-600',
      bgColor: 'bg-green-50',
      description: 'For business inquiries and partnerships'
    },
    {
      icon: Phone,
      title: 'Call Us',
      value: '+254 791 286 165',
      href: 'tel:+254791286165',
      color: 'text-purple-600',
      bgColor: 'bg-purple-50',
      description: 'Available during business hours'
    },
    {
      icon: MessageCircle,
      title: 'WhatsApp',
      value: '+254 791 286 165',
      href: 'https://wa.me/254791286165',
      color: 'text-emerald-600',
      bgColor: 'bg-emerald-50',
      description: 'Quick response on WhatsApp'
    }
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-purple-100">
      <div className="max-w-4xl mx-auto px-4 py-12">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center space-x-2 text-gray-700 hover:text-gray-900 mb-8 transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
          <span>Go Back</span>
        </button>

        <div className="bg-white rounded-2xl shadow-xl overflow-hidden">
          <div className="bg-gradient-to-r from-indigo-600 to-purple-600 p-8 text-white">
            <h1 className="text-3xl font-bold mb-2">Get in Touch</h1>
            <p className="text-indigo-100">
              We're here to help with any questions about our payment services
            </p>
          </div>

          <div className="p-8">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
              {contactMethods.map((method, index) => {
                const Icon = method.icon;
                return (
                  <a
                    key={index}
                    href={method.href}
                    target={method.href.startsWith('http') ? '_blank' : undefined}
                    rel={method.href.startsWith('http') ? 'noopener noreferrer' : undefined}
                    className="block p-6 border-2 border-gray-100 rounded-xl hover:border-indigo-300 hover:shadow-lg transition-all duration-300 group"
                  >
                    <div className="flex items-start space-x-4">
                      <div className={`${method.bgColor} p-3 rounded-lg group-hover:scale-110 transition-transform`}>
                        <Icon className={`w-6 h-6 ${method.color}`} />
                      </div>
                      <div className="flex-1">
                        <h3 className="font-semibold text-gray-900 mb-1 flex items-center">
                          {method.title}
                          {method.href.startsWith('http') && (
                            <ExternalLink className="w-4 h-4 ml-2 text-gray-400" />
                          )}
                        </h3>
                        <p className="text-sm text-gray-600 mb-2">{method.description}</p>
                        <p className={`font-medium ${method.color} group-hover:underline`}>
                          {method.value}
                        </p>
                      </div>
                    </div>
                  </a>
                );
              })}
            </div>

            <div className="bg-gray-50 rounded-xl p-6 border border-gray-200">
              <h2 className="text-lg font-bold text-gray-900 mb-4">Business Hours</h2>
              <div className="space-y-2 text-sm text-gray-700">
                <div className="flex justify-between">
                  <span className="font-medium">Monday - Friday:</span>
                  <span>8:00 AM - 6:00 PM EAT</span>
                </div>
                <div className="flex justify-between">
                  <span className="font-medium">Saturday:</span>
                  <span>9:00 AM - 2:00 PM EAT</span>
                </div>
                <div className="flex justify-between">
                  <span className="font-medium">Sunday:</span>
                  <span className="text-red-600">Closed</span>
                </div>
              </div>
              <p className="text-xs text-gray-500 mt-4">
                For urgent matters outside business hours, please send an email or WhatsApp message and we'll respond as soon as possible.
              </p>
            </div>

            <div className="mt-8 pt-8 border-t border-gray-200">
              <h2 className="text-lg font-bold text-gray-900 mb-4">About Our Payment Service</h2>
              <p className="text-gray-700 leading-relaxed mb-4">
                Cogvana Payments is integrated with your Property Management System to provide seamless rent collection and payment processing. We support M-PESA and Airtel Money for convenient mobile money transactions.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
                <div className="text-center p-4 bg-indigo-50 rounded-lg">
                  <p className="text-2xl font-bold text-indigo-600 mb-1">1.5%</p>
                  <p className="text-sm text-gray-600">Platform Fee</p>
                </div>
                <div className="text-center p-4 bg-green-50 rounded-lg">
                  <p className="text-2xl font-bold text-green-600 mb-1">24/7</p>
                  <p className="text-sm text-gray-600">Payment Processing</p>
                </div>
                <div className="text-center p-4 bg-purple-50 rounded-lg">
                  <p className="text-2xl font-bold text-purple-600 mb-1">Instant</p>
                  <p className="text-sm text-gray-600">Payment Updates</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-8 text-center text-sm text-gray-600">
          <p>© 2024 Cogvana. All rights reserved.</p>
          <div className="mt-2 space-x-4">
            <a href="#" className="hover:text-indigo-600 transition-colors">Privacy Policy</a>
            <span>•</span>
            <a href="#" className="hover:text-indigo-600 transition-colors">Terms of Service</a>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Contact;